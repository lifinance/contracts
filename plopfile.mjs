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
        path: 'src/Facets/{{titleCase name}}Facet.sol',
        templateFile: 'templates/facet.template.hbs',
      },
      {
        type: 'add',
        path: 'docs/{{titleCase name}}Facet.md',
        templateFile: 'templates/facetDoc.template.hbs',
      }
    ], // array of actions
  })
  
  plop.setHelper('titleCase', (str) => {
    return str.replace(/\w\S*/g, function (txt) {
      return txt.charAt(0).toUpperCase() + txt.substr(1).toLowerCase()
    })
  })

  plop.setHelper('snakeCase', (str) => {
    return str
      .replace(/\W+/g, ' ')
      .split(/ |\B(?=[A-Z])/)
      .map((word) => word.toLowerCase())
      .join('_')
  })
}
