/**
 * Logic for optimizing .html files (note: this will )
 */
const fs = require('fs');
const path = require('path');
const moo = require('moo');
const {isRemoteModule, projectURL, removeLeadingSlash, insert} = require('../util');
const {scanJS} = require('./js');

/** Parse HTML */
function parseHTML(htmlDoc) {
  /**
   * This isn’t a complete HTML parser by any means; this is a fast, bare-bones
   * parser that only gives us rudimentary understanding of where tags,
   * attributes, and comments start and end (moo is basically a safer,
   * glorified RegEx builder). We’re not using jsdom, etc. here because we only
   * need basic parsing and HTML manipulation, not the whole kitchen sink.
   */
  const lexer = moo.states({
    main: {
      commentStart: {match: /<!--/, push: 'comment'},
      docType: /<![^>]+>/,
      tagOpen: {
        match: /<\s*[a-zA-Z-]+/,
        lineBreaks: true,
        push: 'tag',
        value: (text) => text.toLowerCase().replace(/\s/g, ''),
      }, // normalize tag case
      tagClose: {
        match: /<\/\s*[a-zA-Z-]+\s*>/,
        lineBreaks: true,
        value: (text) => text.toLowerCase().replace(/\s/g, ''),
      },
      nl: {match: /\r?\n/, lineBreaks: true},
      indent: /[\t| ]+/,
      any: {match: /.+/, lineBreaks: true},
    },
    comment: {
      commentEnd: {match: /\s*-->/, pop: 1}, // exit comment
      commentAny: {match: /./, lineBreaks: true},
    },
    tag: {
      tagSelfClose: {match: /\/>/, pop: 1}, // exit tag
      tagEnd: {match: />/, pop: 1}, // exit tag
      attrName: {match: /[a-zA-Z-]+/, push: 'attr', value: (attr) => attr.toLowerCase()},
      tagWS: {match: /[\t|\s]+/, lineBreaks: true},
      tagAny: {match: /.+/, lineBreaks: true},
    },
    attr: {
      attrAssignment: {match: /=/, lineBreaks: true, value: (attr) => attr.trim()}, // capture `=` first
      attrEnd: {match: /\s/, lineBreaks: true, pop: 1}, // any whitespace not surrounding `=` means it’s a boolean attr; exit
      attrValue: {
        match: /"[^"]+"/,
        value: (attr) =>
          attr
            .trim()
            .replace(/^('|")?/g, '"')
            .replace(/("|')?$/, '"'), // normalize single- and non-quotes to double-quotes
        pop: 1, // exit attribute
      },
      attrAny: {match: /.+/, lineBreaks: true},
    },
  });
  return lexer.reset(htmlDoc);
}

/** Scan HTML for static imports */
async function scanHTML(htmlFiles, buildDirectory) {
  const importList = {};
  await Promise.all(
    htmlFiles.map(async (file) => {
      // TODO: add debug in plugins?
      // log(`scanning ${projectURL(file, buildDirectory)} for imports`, 'debug');

      const allCSSImports = new Set(); // all CSS imports for this HTML file
      const allJSImports = new Set(); // all JS imports for this HTML file
      const entry = new Set(); // keep track of HTML entry files

      const code = await fs.promises.readFile(file, 'utf-8');
      const html = parseHTML(code);

      // traverse DOM from start to end using moo
      let node = html.next();
      while (node) {
        // <link>
        if (node.type === 'tagOpen' && node.value === '<link') {
          // 1. iterate through properties until we get to `href=*`
          let attrStart = html.next(); // note: .next() keeps state, so we save wasted cycles by calling it early here
          while (attrStart.type !== 'attrName' && attrStart.value !== 'href')
            attrStart = html.next();
          // 2. get the next attrValue
          let href = html.next();
          while (href.type !== 'attrValue') href = html.next();
          // 3. remove surrounding quotes
          href = href.value.replace(/^"/, '').replace(/"$/, '');
          // 4. normalize & add to list
          const resolvedCSS =
            href[0] === '/' ? path.join(buildDirectory, href) : path.join(path.dirname(file), href);
          allCSSImports.add(resolvedCSS);
        }

        // <script>
        if (node.type === 'tagOpen' && node.value === '<script') {
          // 1. iterate through properties until we get to `src=*`
          let attrStart = html.next();
          while (attrStart.type !== 'attrName' && attrStart.value !== 'src')
            attrStart = html.next();
          // 2. get the next attrValue
          let src = html.next();
          while (src.type !== 'attrValue') src = html.next();
          // 3. remove surrounding quotes
          src = src.value.replace(/^"/, '').replace(/"$/, '');
          // 4. normalize & add to list
          const resolvedJS =
            src[0] === '/' ? path.join(buildDirectory, src) : path.join(path.dirname(file), src);
          allJSImports.add(resolvedJS);
          entry.add(resolvedJS);
        }

        node = html.next(); // move to next node, which will return `undefined` when we’re at the end of the doc, exiting the loop
      }

      // traverse all JS for other static imports (scannedFiles keeps track of files so we never redo work)
      const scannedFiles = new Set();
      allJSImports.forEach((file) => {
        scanJS({
          file,
          rootDir: buildDirectory,
          scannedFiles,
          importList: allJSImports,
        }).forEach((i) => allJSImports.add(i));
      });

      // return
      importList[file] = {
        entry: Array.from(entry),
        css: Array.from(allCSSImports),
        js: Array.from(allJSImports),
      };
    }),
  );
  return importList;
}
exports.scanHTML = scanHTML;

/** Inject HTML at key points in document */
function injectHTML(htmlDoc, {headEnd, bodyEnd}) {
  const html = parseHTML(htmlDoc);
  let code = htmlDoc;
  let indent = '';
  let node = html.next();
  let charOffset = 0; // Note: here, we reuse one parse for multiple insertions, whereas in transformCSSProxy() we re-parse every time. Reason is the latter is more complicated with transforms; this is simple injection
  while (node) {
    if (node.type === 'indent') {
      indent = node.value; // keep track of last indent for cleaner injections
    }

    // Note: headStart and bodyStart not implemented, but easily could be

    if (headEnd && node.type === 'tagClose' && node.value === '</head>') {
      const insertion = `${indent[0] === ' ' ? indent + '  ' : indent + '\t'}${headEnd}\n`;
      code = insert(code, insertion, node.offset + charOffset);
      charOffset += insertion.length;
    }
    if (bodyEnd && node.type === 'tagClose' && node.value === '</body>') {
      const insertion = `${indent[0] === ' ' ? indent + '  ' : indent + '\t'}${bodyEnd}\n`;
      code = insert(code, insertion, node.offset + charOffset);
      charOffset += insertion.length;
    }
    node = html.next();
  }
  return code;
}
exports.injectHTML = injectHTML;

/** Given a set of HTML files, trace the imported JS */
function preloadJS({code, rootDir, htmlFile, preloadCSS}) {
  let headHTML = '';
  let bodyHTML = '';

  const originalEntries = new Set(); // original entry files in HTML
  const allModules = new Set(); // all modules required by this HTML file

  // 1. scan HTML for <script> tags
  const html = parseHTML(code);
  let node = html.next();
  while (node) {
    // <script type="module" src="*">
    if (node.type === 'tagOpen' && node.value === '<script') {
      let src = '';
      let type = '';

      // iterate through tag properties until we find type="module" AND src="*"
      // (this is a bit tricky because we need src="" AND type="module", and we’re not sure about the order
      while (!src && !type) {
        node = html.next();
        if (node.type === 'attrName') {
          if (node.value === 'src') {
            while (node.type !== 'attrValue') {
              node = html.next();
              if (node.type === 'tagEnd' || node.type === 'tagSelfClose') break; // tag ended early; move on
            }
            src = node.value;
          } else if (node.value === 'type') {
            while (node.type !== 'attrValue') {
              node = html.next();
              if (node.type === 'tagEnd' || node.type === 'tagSelfClose') break; // tag ended early; move on
            }
            type = node.value;
          }
        }
        if (node.type === 'tagEnd' || node.type === 'tagSelfClose') break; // tag ended early; move on
      }

      if (src && type == '"module"') {
        src = src.value.replace(/^"/, '').replace(/"$/, '');
        const resolvedJS =
          src[0] === '/' ? path.join(buildDirectory, src) : path.join(path.dirname(file), src);
        originalEntries.add(resolvedJS);
      }
    }
    node = html.next();
  }

  // 2. scan entries for additional imports
  const scannedFiles = new Set(); // keep track of files scanned so we don’t get stuck in a circular dependency
  originalEntries.forEach((entry) => {
    scanJS({
      file: entry,
      rootDir,
      scannedFiles,
      importList: allModules,
    }).forEach((file) => allModules.add(file));
  });

  // 3. add CSS manifest (if applicable)
  if (cssName) headHTML += `<link rel="stylesheet" href="${cssName}" />\n`;

  // 4. add module preload to HTML (https://developers.google.com/web/updates/2017/12/modulepreload)
  const resolvedModules = [...allModules]
    .filter((m) => !originalEntries.has(m)) // don’t double-up preloading scripts that were already in the HTML
    .filter((m) => preloadCSS && !m.endsWith('.css.proxy.js')) // if preloading CSS, don’t preload .css.proxy.js
    .map((src) => projectURL(rootDir, src));
  if (!resolvedModules.length) return code; // don’t add useless whitespace

  resolvedModules.sort((a, b) => a.localeCompare(b));

  headHTML +=
    `  <!-- [@snowpack/plugin-optimize] Add modulepreload to improve unbundled load performance (More info: https://developers.google.com/web/updates/2017/12/modulepreload) -->\n` +
    resolvedModules.map((src) => `    <link rel="modulepreload" href="${src}" />`).join('\n') +
    '\n  ';
  bodyHTML +=
    `  <!-- [@snowpack/plugin-optimize] modulepreload fallback for browsers that do not support it yet -->\n    ` +
    resolvedModules.map((src) => `<script type="module" src="${src}"></script>`).join('') +
    '\n  ';

  // return HTML with preloads added
  return injectHTML(code, {headEnd: headHTML, bodyEnd: bodyHTML});
}
exports.preloadJS = preloadJS;
