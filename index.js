const jsdoc = require('jsdoc-api');
const handlebars = require('handlebars');
const helpers = require('handlebars-helpers')();
const fs = require('fs');

handlebars.registerHelper('markdown', helpers.markdown);
handlebars.registerHelper('capitalize', helpers.capitalize);
handlebars.registerHelper('default', helpers.default);
handlebars.registerHelper('uppercase', helpers.uppercase);
handlebars.registerHelper('trimLeft', helpers.trimLeft);

function hasTag(item, tagName) {
  if (item.tags) {
    return item.tags.find(tag => tag.title == tagName) != null;
  }

  return false;
}

function resolveBadges(item) {
  const res = [];

  if (hasTag(item, 'cached') || hasTag(item, 'cache')) {
    res.push('![Cached action](https://img.shields.io/badge/cache-true-blue.svg)');
  }

  if (item.deprecated) {
    res.push('![Deprecated action](https://img.shields.io/badge/status-deprecated-orange.svg)');
  }

  if (item.async) {
    res.push('<span class="badge badge-info">async</span>');
  }

  if (!item.access || item.access == 'public') {
    res.push(`<span class="badge badge-primary">${item.access || 'public'}</span>`)
  }

  if (item.access == 'protected') {
    res.push("<span class='badge badge-dark'>protected</span>");
  }

  return res;
}

function setProperty(obj, path, item) {
  const properties = path.split('.');
  const name = properties.pop();

  if (properties.length === 0) {
    if (name.includes('~')) {
      const [parent, member] = name.split('~');
      obj[parent].members = obj[parent].members || {};
      obj[parent].members[member] = item;
    } else {
      obj[path] = item;
    }
    return;
  }

  const innerProperty = properties.reduce((curr, p) => {
    if (!curr[p]) {
      curr[p] = {};
    }

    return curr[p];
  }, obj);

  if (name.includes('~')) {
    const [parent, member] = name.split('~');
    innerProperty[parent].members = innerProperty[parent].members || {};
    innerProperty[parent].members[member] = item;
  } else {
    innerProperty[name] = item;
  }
}

function replaceExternal(types, ref) {
  for (let i = 0; i <= types.length; i++) {
    if (ref[types[i]]) {
      types[i] = ref[types[i]];
    }
  }
}

function resolveType(types, ref) {
  const pre = types.map(name => name.replace(/\.</g, '<'))
      .map(name => name.replace(/</g, '&#60;'))
      .map(name => name.replace(/>/g, '&#62;'))
      .map(name => {
        const keys = Object.keys(ref).join('|');
        const re = new RegExp(`<?(${keys})>?`);
        const matching = name.match(re);

        if (!matching) {
          return `<code>${name}</code>`;
        }

        const [keyword] = matching;
        const link = name.replace(keyword, ref[keyword]);

        return `<code>${link}</code>`;
      });
  return pre.join(',');
}


const tokens = jsdoc.explainSync({
  files: 'src/*/*',
  package: './package.json',
  recurse: true
}).filter(token => !token.undocumented);
const namespaces = ['services', 'errors'];
const external = tokens.filter(item => item.kind === 'external'
    && item.see instanceof Array)
    .reduce((obj, token) => {
      obj[token.name] = `<a href="${token.see[0]}">${token.name}</a>`;
      return obj;
    }, {});

const definitions = tokens.filter(t => t.kind === 'typedef')
    .map(token => {
      token.longname = `definitions:${token.name}`;
      external[token.name] = `<a href="#${token.longname}">${token.name}</a>`;
      if (token.properties) {
        token.properties.forEach(property => {
          property.types = resolveType(property.type.names, external);
        })
      }
      if (token.augments) {
        token.augments = resolveType(token.augments, external);
      }
        return token;
    });
const events = tokens.filter(t => t.kind === 'event')
    .map(token => {
      const name = `${token.memberof}.${token.name}`;
      const wPrefix = `events:${token.longname}`;

      external[token.longname] = `<a href="#${wPrefix}">${name}</a>`;
      token.longname = wPrefix;
      token.name = token.alias || name;

      if (token.alias) {
        token.filename = name;
      }

      if (token.properties) {
        token.properties.forEach(property => {
          property.types = resolveType(property.type.names, external);
        })
      }

      return token;
    });

const doc = {
  ns: []
};

for (const name of namespaces) {
  const tokensOfInterest = tokens.filter(item => item.longname.startsWith(name)
      && !['event', 'typedef', 'external', 'namespace'].includes(item.kind));
  const members = [];
  let prefix = '';
  let moduleDef = null;

  for (const token of tokensOfInterest) {
    if (token.kind === 'module') {
      if (moduleDef !== null) {
        members.push(moduleDef);
      }

      prefix = token.longname;
      moduleDef = {
        description:  token.description,
        name: token.name,
        longname: token.longname,
        filename: token.meta.filename,
        children: {}
      };
    } else {
      const regex = new RegExp(`${prefix}.?`);
      const member = token.longname.replace(regex, '');

      if (token.mixes) {
        replaceExternal(token.mixes, external);
      }

      if (token.type) {
        token.type = resolveType(token.type.names, external);
      }

      if (token.properties) {
        token.properties.forEach(property => {
          property.types = resolveType(property.type.names, external);
        })
      }

      if (token.params) {
        token.params.forEach(param => {
          param.types = resolveType(param.type.names, external);
        })
      }

      if (token.returns) {
        token.returns.forEach(param => {
          param.types =resolveType(param.type.names, external);
        });
      }

      if (token.kind === 'function') {
        token.badges = resolveBadges(token);
      }

      if (token.listens) {
        token.listens = token.listens.map(e => {
          return {
            name: external[e],
            link: e
          };
        })
      }

      if (token.fires) {
        token.fires = token.fires.map(e => {
          return external[e];
        })
      }

      // errors should be: errors.NameofError
      if (token.exceptions) {
        token.exceptions.forEach(exc => {
          const longname = exc.type ? exc.type.names[0] : 'Error';
          const [_, name] = longname.split('.');

          if (name) {
            exc.name = `<a href="#${longname}">${name}</a>`;
          } else {
            exc.name = longname;
          }
        });
      }

      if (token.kind === 'class') {
        token.description = token.classdesc;
        token.class = true;
      }

      token.__final = true;
      if (!moduleDef) {
        members.push(token);
      } else {
        setProperty(moduleDef.children, member, token);
      }
    }
  }

  if (moduleDef !== null) {
    members.push(moduleDef);
  }

  doc.ns.push({
    name,
    members
  });
}

doc.ns.push({
  name: 'definitions',
  members: definitions.sort((a, b) => a.name.localeCompare(b.name))
});

doc.ns.push({
  name: 'events',
  members: events,
});

const [package] = tokens.filter(t => t.kind == 'package');

doc.title = package.name;
doc.description = package.description;
doc.version = package.version;

const path = require('path');
const templatePath = path.resolve(__dirname, 'template.hbs');
const configPath = path.resolve(process.cwd(), '.jsdoc.config.js');
const template = fs.readFileSync(templatePath).toString();
const settings = require(configPath);

// template settings
doc.icon = settings.icon;

const render = handlebars.compile(template);

fs.writeFileSync(settings.output, render(doc));
