/* eslint-disable no-restricted-syntax, no-await-in-loop */
import { Command } from 'commander';
import execa from 'execa';
import { resolve, join } from 'path';
import { getJunitXml } from 'junit-xml';

import { getOptions, getCommand, getOptionsOrPrompt, createOptions } from './utils/options';
import type { OptionSpecifier } from './utils/options';
import { filterDataForCurrentCircleCINode } from './utils/concurrency';

import TEMPLATES from '../code/lib/cli/src/repro-templates';
import { outputFile } from 'fs-extra';

const sandboxDir = resolve(__dirname, '../sandbox');

export type Cadence = 'ci' | 'daily' | 'weekly';
export type Template = {
  name: string;
  script: string;
  cadence?: readonly Cadence[];
  skipScripts?: string[];
  // there are other fields but we don't use them here
};
export type TemplateKey = string;
export type Templates = Record<TemplateKey, Template>;

export async function parseCommand(commandline: string) {
  const argv = commandline.split(' ');

  const [yarnOrNpx, scriptName] = argv;

  try {
    const { options } = await import(`./${scriptName}`);

    const command = new Command(scriptName);
    const values = getOptions(command, options as OptionSpecifier, [yarnOrNpx, ...argv]);

    return {
      scriptName,
      command: `yarn ${scriptName}`,
      options,
      values,
    };
  } catch (err) {
    return {
      scriptName,
      command: commandline,
    };
  }
}

export const options = createOptions({
  step: {
    type: 'string',
    description: 'What type of step are you taking per template (for logging and test results)?',
  },
  cadence: {
    type: 'string',
    description: 'What cadence are we running on (i.e. which templates should we use)?',
    values: ['ci', 'daily', 'weekly'] as const,
    required: true,
  },
  script: {
    type: 'string',
    description: 'What command are we running?',
  },
  parallel: {
    type: 'boolean',
    description: 'Run commands in parallel?',
  },
  cd: {
    type: 'boolean',
    description: 'Change directory into sandbox?',
    inverse: true,
  },
  junit: {
    type: 'string',
    description: 'Report results to junit XML file at path',
  },
});

export function filterTemplates(templates: Templates, cadence: Cadence, scriptName: string) {
  const allTemplates = Object.entries(templates);
  const cadenceTemplates = allTemplates.filter(([, template]) =>
    template.cadence.includes(cadence)
  );
  const jobTemplates = cadenceTemplates.filter(([, t]) => !t.skipScripts?.includes(scriptName));
  return Object.fromEntries(filterDataForCurrentCircleCINode(jobTemplates));
}

type RunResult = {
  template: TemplateKey;
  timestamp: Date;
  time: number;
  ok: boolean;
  output?: string;
  err?: Error;
};

const logger = console;
async function runCommand(
  command: string,
  execaOptions: execa.Options,
  { step, template }: { step: string; template: string }
): Promise<RunResult> {
  const timestamp = new Date();
  try {
    logger.log(`${step} ${template}: Running ${command}`);

    const { all } = await execa.command(command, execaOptions);

    console.log(`${step} ${template}: Done.`);

    return { template, timestamp, time: (Date.now() - +timestamp) / 1000, ok: true, output: all };
  } catch (err) {
    console.log(`${step} ${template}: Failed.`);
    return { template, timestamp, time: (Date.now() - +timestamp) / 1000, ok: false, err };
  }
}

async function writeJunitXml(step: string, start: Date, results: RunResult[], path: string) {
  const junitXml = getJunitXml({
    time: (Date.now() - +start) / 1000,
    name: `${step} Templates`,
    suites: results.map(({ template, timestamp, time, ok, err, output }) => ({
      name: template,
      timestamp,
      time,
      testCases: [
        {
          name: `${step} ${template}`,
          assertions: 1,
          time,
          systemOut: output?.split('\n'),
          ...(!ok && {
            errors: [err],
          }),
        },
      ],
    })),
  });
  await outputFile(path, junitXml);
  console.log(`Test results written to ${resolve(path)}`);
}

async function run() {
  const {
    step = 'Testing',
    cadence,
    script: commandline,
    parallel,
    cd,
    junit: junitPath,
  } = await getOptionsOrPrompt('yarn multiplex-templates', options);

  const command = await parseCommand(commandline);
  const templates = filterTemplates(TEMPLATES, cadence, command.scriptName);

  const start = new Date();
  const toAwait = [];
  for (const template of Object.keys(templates)) {
    let toRun = command.command;

    if (command.options) {
      toRun = getCommand(command.command, command.options, {
        ...command.values,
        template,
      });
    }

    // Do some simple variable substitution
    const templateEnv = template.toUpperCase().replace(/\/-/, '_');
    toRun = toRun.replace('$TEMPLATE_ENV', templateEnv);
    const templateDir = template.replace('/', '-');
    toRun = toRun.replace('$TEMPLATE_DIR', templateDir);
    toRun = toRun.replace('$TEMPLATE', template);

    const execaOptions = cd ? { cwd: join(sandboxDir, templateDir) } : {};
    if (parallel) {
      toAwait.push(runCommand(toRun, execaOptions, { step, template }));
    } else {
      toAwait.push(
        Promise.resolve(
          await runCommand(toRun, { stdio: 'inherit', ...execaOptions }, { step, template })
        )
      );
    }
  }

  const results = await Promise.all(toAwait);
  if (junitPath) {
    await writeJunitXml(step, start, results, junitPath);
  }
}

if (require.main === module) {
  run().catch((err) => {
    console.error('Multiplexing failed');
    console.error(err);
    process.exit(1);
  });
}
