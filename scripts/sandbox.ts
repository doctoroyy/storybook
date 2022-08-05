/* eslint-disable no-restricted-syntax, no-await-in-loop */
import path from 'path';
import { remove, pathExists, readJSON, writeJSON, ensureSymlink } from 'fs-extra';
import prompts from 'prompts';

import { createOptions, getOptionsOrPrompt } from './utils/options';
import { executeCLIStep } from './utils/cli-step';
import { installYarn2, configureYarn2ForVerdaccio, addPackageResolutions } from './utils/yarn';
import { exec } from './utils/exec';
import { getInterpretedFile } from '../code/lib/core-common';
import { ConfigFile, readConfig, writeConfig } from '../code/lib/csf-tools';
import { babelParse } from '../code/lib/csf-tools/src/babelParse';
import TEMPLATES from '../code/lib/cli/src/repro-templates';

type Template = keyof typeof TEMPLATES;
const templates: Template[] = Object.keys(TEMPLATES) as any;
const addons = ['a11y', 'storysource'];
const defaultAddons = [
  'actions',
  'backgrounds',
  'controls',
  'docs',
  'highlight',
  'links',
  'interactions',
  'measure',
  'outline',
  'toolbars',
  'viewport',
];
const sandboxDir = path.resolve(__dirname, '../sandbox');
const codeDir = path.resolve(__dirname, '../code');

export const options = createOptions({
  template: {
    description: 'Which template would you like to use?',
    values: templates,
    required: true as const,
  },
  addon: {
    description: 'Which extra addons (beyond the CLI defaults) would you like installed?',
    values: addons,
    multiple: true as const,
  },
  includeStories: {
    description: "Include Storybook's own stories?",
    promptType: (_, { framework }) => framework === 'react',
  },
  create: {
    description: 'Create the template from scratch (rather than degitting it)?',
  },
  forceDelete: {
    description: 'Always delete an existing sandbox, even if it has the same configuration?',
    promptType: false,
  },
  forceReuse: {
    description: 'Always reuse an existing sandbox, even if it has a different configuration?',
    promptType: false,
  },
  link: {
    description: 'Link the storybook to the local code?',
    inverse: true,
  },
  publish: {
    description: 'Publish local code to verdaccio before installing?',
    inverse: true,
    promptType: (_, { link }) => !link,
  },
  start: {
    description: 'Start the Storybook?',
    inverse: true,
  },
  build: {
    description: 'Build the Storybook?',
  },
  watch: {
    description: 'Start building used packages in watch mode as well as the Storybook?',
  },
  dryRun: {
    description: "Don't execute commands, just list them (dry run)?",
  },
});

async function getOptions() {
  return getOptionsOrPrompt('yarn sandbox', options);
}

const steps = {
  repro: {
    command: 'repro-next',
    description: 'Bootstrapping Template',
    icon: '👷',
    hasArgument: true,
    options: {
      // TODO allow string valued options without fixed values
      output: { values: [] as string[] },
      // TODO allow default values for strings
      branch: { values: ['next'] },
    },
  },
  add: {
    command: 'add',
    description: 'Adding addon',
    icon: '+',
    hasArgument: true,
    options: {},
  },
  link: {
    command: 'link',
    description: 'Linking packages',
    icon: '🔗',
    hasArgument: true,
    options: { local: {}, start: { inverse: true } },
  },
  build: {
    command: 'build',
    description: 'Building Storybook',
    icon: '🔨',
    options: {},
  },
  dev: {
    command: 'dev',
    description: 'Starting Storybook',
    icon: '🖥 ',
    options: {},
  },
};

const logger = console;

async function findFirstPath(paths: string[], { cwd }: { cwd: string }) {
  for (const filePath of paths) {
    if (await pathExists(path.join(cwd, filePath))) return filePath;
  }
  return null;
}

async function addPackageScripts({
  cwd,
  scripts,
}: {
  cwd: string;
  scripts: Record<string, string>;
}) {
  logger.info(`🔢 Adding package scripts:`);
  const packageJsonPath = path.join(cwd, 'package.json');
  const packageJson = await readJSON(packageJsonPath);
  packageJson.scripts = {
    ...packageJson.scripts,
    ...scripts,
  };
  await writeJSON(packageJsonPath, packageJson, { spaces: 2 });
}

async function readMainConfig({ cwd }: { cwd: string }) {
  const configDir = path.join(cwd, '.storybook');
  const mainConfigPath = getInterpretedFile(path.resolve(configDir, 'main'));
  return readConfig(mainConfigPath);
}

// NOTE: the test regexp here will apply whether the path is symlink-preserved or otherwise
const loaderPath = require.resolve('../code/node_modules/esbuild-loader');
const webpackFinalCode = `
  (config) => ({
    ...config,
    module: {
      ...config.modules,
      rules: [
        {
          test: [/\\/code\\/[^/]*\\/[^/]*\\/template\\/stories\\//],
          loader: '${loaderPath}',
          options: {
            loader: 'tsx',
            target: 'es2015',
          },
        },
        ...config.module.rules,
      ],
    },
  })`;

// paths are of the form 'renderers/react', 'addons/actions'
async function addStories(paths: string[], { mainConfig }: { mainConfig: ConfigFile }) {
  const stories = mainConfig.getFieldValue(['stories']) as string[];
  const extraStoryDirsAndExistence = await Promise.all(
    paths
      .map((p) => path.join(p, 'template', 'stories'))
      .map(async (p) => [p, await pathExists(path.resolve(codeDir, p))] as const)
  );

  const relativeCodeDir = path.join('..', '..', '..', 'code');
  const extraStories = extraStoryDirsAndExistence
    .filter(([, exists]) => exists)
    .map(([p]) => path.join(relativeCodeDir, p, '*.stories.@(js|jsx|ts|tsx)'));
  mainConfig.setFieldValue(['stories'], [...stories, ...extraStories]);

  mainConfig.setFieldNode(
    ['webpackFinal'],
    // @ts-ignore (not sure why TS complains here, it does exist)
    babelParse(webpackFinalCode).program.body[0].expression
  );
}

async function main() {
  const optionValues = await getOptions();

  const { template, forceDelete, forceReuse, link, publish, dryRun } = optionValues;
  const cwd = path.join(sandboxDir, template.replace('/', '-'));

  const exists = await pathExists(cwd);
  let shouldDelete = exists && !forceReuse;
  if (exists && !forceDelete && !forceReuse) {
    const relativePath = path.relative(process.cwd(), cwd);
    ({ shouldDelete } = await prompts({
      type: 'toggle',
      message: `${relativePath} already exists, should delete it and create a new one?`,
      name: 'shouldDelete',
      initial: false,
      active: 'yes',
      inactive: 'no',
    }));
  }

  if (exists && shouldDelete && !dryRun) await remove(cwd);

  if (!exists || shouldDelete) {
    await executeCLIStep(steps.repro, {
      argument: template,
      optionValues: { output: cwd, branch: 'next' },
      cwd: sandboxDir,
      dryRun,
    });

    const mainConfig = await readMainConfig({ cwd });

    const templateConfig = TEMPLATES[template as Template];
    const storiesPath = await findFirstPath([path.join('src', 'stories'), 'stories'], { cwd });

    // Link in the template/components/index.js from the renderer
    const rendererName = templateConfig.expected.renderer.split('/')[1];
    const rendererPath = path.join('renderers', rendererName);
    await ensureSymlink(
      path.join(codeDir, rendererPath, 'template', 'components'),
      path.resolve(cwd, storiesPath, 'components')
    );
    mainConfig.setFieldValue(
      ['previewEntries'],
      [`.${path.sep}${path.join(storiesPath, 'components')}`]
    );

    const storiesToAdd = [] as string[];
    storiesToAdd.push(rendererPath);

    // TODO -- sb add <addon> doesn't actually work properly:
    //   - installs in `deps` not `devDeps`
    //   - does a `workspace:^` install (what does that mean?)
    //   - doesn't add to `main.js`

    for (const addon of optionValues.addon) {
      const addonName = `@storybook/addon-${addon}`;
      await executeCLIStep(steps.add, { argument: addonName, cwd, dryRun });
    }

    for (const addon of [...defaultAddons, ...optionValues.addon]) {
      storiesToAdd.push(path.join('addons', addon));
    }
    await addStories(storiesToAdd, { mainConfig });

    await writeConfig(mainConfig);

    await installYarn2({ cwd, dryRun });
    if (link) {
      await executeCLIStep(steps.link, {
        argument: cwd,
        cwd: codeDir,
        dryRun,
        optionValues: { local: true, start: false },
      });
    } else {
      if (publish) {
        await exec('yarn local-registry --publish', { cwd: codeDir }, { dryRun });

        // NOTE: this is a background task and will run forever (TODO: sort out logging/exiting)
        exec('CI=true yarn local-registry --open', { cwd: codeDir }, { dryRun });
        await exec('yarn wait-on http://localhost:6000', { cwd: codeDir }, { dryRun });
      }

      // We need to add package resolutions to ensure that we only ever install the latest version
      // of any storybook packages as verdaccio is not able to both proxy to npm and publish over
      // the top. In theory this could mask issues where different versions cause problems.
      await addPackageResolutions({ cwd, dryRun });
      await configureYarn2ForVerdaccio({ cwd, dryRun });

      await exec(
        'yarn install',
        { cwd },
        {
          dryRun,
          startMessage: `⬇️ Installing local dependencies`,
          errorMessage: `🚨 Installing local dependencies failed`,
        }
      );
    }

    await addPackageScripts({
      cwd,
      scripts: {
        storybook:
          'NODE_OPTIONS="--preserve-symlinks --preserve-symlinks-main" storybook dev -p 6006',
        'build-storybook':
          'NODE_OPTIONS="--preserve-symlinks --preserve-symlinks-main" storybook build',
      },
    });
  }

  const { start, build } = optionValues;
  if (start) {
    await exec(
      'yarn storybook',
      { cwd },
      {
        dryRun,
        startMessage: `⬆️  Starting Storybook`,
        errorMessage: `🚨 Starting Storybook failed`,
      }
    );
  } else if (build) {
    await executeCLIStep(steps.build, { cwd, dryRun });
    // TODO serve
  }

  // TODO start dev
}

if (require.main === module) {
  main().catch((err) => console.error(err));
}
