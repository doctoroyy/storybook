/* eslint-disable no-restricted-syntax, no-await-in-loop */
import { Command } from 'commander';
import execa from 'execa';

import { getOptions, getCommand, getOptionsOrPrompt, createOptions } from './utils/options';
import type { OptionSpecifier } from './utils/options';
import { filterDataForCurrentCircleCINode } from './utils/concurrency';

import TEMPLATES from '../code/lib/cli/src/repro-templates';

async function parseCommand(commandline: string) {
  const argv = commandline.split(' ');

  const [yarn, scriptName] = argv;
  if (yarn !== 'yarn') throw new Error('only works with scripts at this point');

  const { options } = await import(`./${scriptName}`);

  const command = new Command(scriptName);
  const values = getOptions(command, options as OptionSpecifier, ['yarn', ...argv]);

  return {
    command: `yarn ${scriptName}`,
    options,
    values,
  };
}

export const options = createOptions({
  cadence: {
    description: 'What cadence are we running on (i.e. which templates should we use)?',
    values: ['ci', 'daily', 'weekly'],
    required: true as const,
  },
  script: {
    description: 'What command are we running?',
    // FIXME: totally not right, just a placeholder until we are allowed arbitrarily valued string options
    values: ['yarn sandbox --no-link --no-start --no-publish'],
  },
  parallel: {
    description: 'Run commands in parallel?',
  },
});

async function run() {
  const { script: commandline, parallel } = await getOptionsOrPrompt(
    'yarn multiplex-templates',
    options
  );

  const command = await parseCommand(commandline);

  const allTemplates = Object.keys(TEMPLATES);
  // TODO -- filter by cadence
  const templates = filterDataForCurrentCircleCINode(allTemplates);

  const toAwait = [];
  for (const template of templates) {
    const toRun = getCommand(command.command, command.options, {
      ...command.values,
      template,
    });

    console.log(`Running ${toRun}`);

    if (parallel) {
      // Don't pipe stdio as it'll get interleaved
      toAwait.push(
        (async () => {
          await execa.command(toRun);
          console.log(`Done with ${toRun}`);
        })()
      );
    } else {
      await execa.command(toRun, { stdio: 'inherit' });
    }
  }

  await Promise.all(toAwait);
}

if (require.main === module) {
  run();
}
