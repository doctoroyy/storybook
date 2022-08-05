// auto generated file, do not edit
export default {
  'cra/default-js': {
    name: 'Create React App (Javascript)',
    script: 'npx create-react-app .',
    cadence: ['ci', 'daily', 'weekly'],
    expected: {
      framework: '@storybook/cra',
      renderer: '@storybook/react',
      builder: '@storybook/builder-webpack5',
    },
  },
  'cra/default-ts': {
    name: 'Create React App (Typescript)',
    script: 'npx create-react-app . --template typescript',
    cadence: ['ci', 'daily', 'weekly'],
    expected: {
      framework: '@storybook/cra',
      renderer: '@storybook/react',
      builder: '@storybook/builder-webpack5',
    },
  },
} as const;
