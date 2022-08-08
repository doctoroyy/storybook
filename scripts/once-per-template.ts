/* eslint-disable no-restricted-syntax, no-await-in-loop */
import { Command } from 'commander';
import execa from 'execa';
import { resolve, join } from 'path';

import { getOptions, getCommand, getOptionsOrPrompt, createOptions } from './utils/options';
import type { OptionSpecifier } from './utils/options';
import { filterDataForCurrentCircleCINode } from './utils/concurrency';

import TEMPLATES from '../code/lib/cli/src/repro-templates';

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

const logger = console;
async function runCommand(
  command: string,
  execaOptions: execa.Options,
  { template }: { template: string }
) {
  try {
    logger.log(`${template}: Running ${command}`);

    await execa.command(command, execaOptions);

    console.log(`${template}: Done.`);
  } catch (err) {
    console.log(`${template}: Failed.`);
  }
}

async function run() {
  const {
    cadence,
    script: commandline,
    parallel,
    cd,
    junit: junitPath,
  } = await getOptionsOrPrompt('yarn multiplex-templates', options);

  const command = await parseCommand(commandline);
  const templates = filterTemplates(TEMPLATES, cadence, command.scriptName);

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
    toRun = toRun.replace('TEMPLATE_ENV', template.toUpperCase().replace(/\/-/, '_'));
    toRun = toRun.replace('TEMPLATE', template);

    const execaOptions = cd ? { cwd: join(sandboxDir, template) } : {};
    if (parallel) {
      toAwait.push(runCommand(toRun, execaOptions, { template }));
    } else {
      await runCommand(toRun, { stdio: 'inherit', ...execaOptions }, { template });
    }
  }

  await Promise.all(toAwait);
}

if (require.main === module) {
  run().catch((err) => {
    console.error('Multiplexing failed');
    console.error(err);
    process.exit(1);
  });
}
