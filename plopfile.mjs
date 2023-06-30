export default function (
  /** @type {import('plop').NodePlopAPI} */
  plop
) {
  plop.setGenerator('facet', {
    description: 'Generates boilerplate for a new facet contract.',
    prompts: [
      {
        type: 'input',
        name: 'name',
        message: 'Give this facet a name:',
      },
      {
        type: 'input',
        name: 'description',
        message: 'Describe what this facet does:',
      }
    ], // array of inquirer prompts
    actions: [
      {
        type: 'add',
        path: 'src/Facets/{{properCase name}}Facet.sol',
        templateFile: 'templates/facet.template.hbs',
      },
      {
        type: 'add',
        path: 'docs/{{properCase name}}Facet.md',
        templateFile: 'templates/facetDoc.template.hbs',
      },
      {
        type: 'add',
        path: 'test/solidity/Facets/{{properCase name}}Facet.t.sol',
        templateFile: 'templates/facetTest.template.hbs',
      },
      {
        type: 'add',
        path: 'config/{{kebabCase name}}.json',
        templateFile: 'templates/facetConfig.template.hbs',
      },
      {
        type: 'add',
        path: 'script/deploy/facets/Deploy{{properCase name}}Facet.s.sol',
        templateFile: 'templates/facetDeployScript.template.hbs',
      },
      {
        type: 'add',
        path: 'script/deploy/facets/Update{{properCase name}}Facet.s.sol',
        templateFile: 'templates/facetUpdateScript.template.hbs',
      }
    ], // array of actions
  })
}
