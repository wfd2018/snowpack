const fs = require('fs');
const path = require('path');
const glob = require('glob');
const colors = require('kleur/colors');
const {minify: minifyHtml} = require('html-minifier');
const {minify: minifyCss} = require('csso');
const esbuild = require('esbuild');
const {init} = require('es-module-lexer');
const mkdirp = require('mkdirp');
const PQueue = require('p-queue').default;
const {buildImportCSS, transformCSSProxy, removeCSSFiles} = require('./lib/css');
const {injectHTML, scanHTML} = require('./lib/html');
const {formatManifest, log} = require('./util');

/**
 * Default optimizer for Snawpack, unless another one is given
 */
exports.default = function plugin(config, userDefinedOptions) {
  const options = {
    minifyJS: true,
    minifyHTML: true,
    minifyCSS: true,
    preloadCSS: true,
    preloadModules: false,
    combinedCSSName: '/imported-styles.css',
    ...(userDefinedOptions || {}),
  };

  const CONCURRENT_WORKERS = require('os').cpus().length;

  async function optimizeFile({esbuildService, file, target, rootDir}) {
    const baseExt = path.extname(file).toLowerCase();

    // TODO: add debug in plugins?
    // log(`optimizing ${projectURL(file, rootDir)}…`, 'debug');

    // optimize based on extension. if it’s not here, leave as-is
    switch (baseExt) {
      case '.css': {
        const shouldOptimize = options.minifyCSS;
        if (!shouldOptimize) return;

        // minify
        let code = fs.readFileSync(file, 'utf-8');
        code = minifyCss(code).css;
        fs.writeFileSync(file, code, 'utf-8');
        return;
      }
      case '.js':
      case '.mjs': {
        const shouldOptimize = options.preloadCSS || options.minifyJS;
        if (!shouldOptimize) return;

        let code = fs.readFileSync(file, 'utf-8');

        // embed CSS
        if (options.preloadCSS) {
          code = transformCSSProxy(file, code);
        }

        // minify if enabled
        if (options.minifyJS) {
          const minified = await esbuildService.transform(code, {minify: true, target});
          code = minified.js;
        }

        fs.writeFileSync(file, code);
        return;
      }
      case '.html': {
        const shouldOptimize = options.preloadCSS || options.preloadModules || options.minifyHTML;
        if (!shouldOptimize) return;

        let code = fs.readFileSync(file, 'utf-8');

        // preload CSS
        if (options.preloadCSS) {
          code = injectHTML(code, {
            headEnd: `<link type="stylesheet" rel="${options.combinedCSSName}" />\n`,
          });
        }

        // preload JS
        if (options.preloadModules) {
          code = preloadJS({code, rootDir, file, preloadCSS: options.preloadCSS});
        }

        // minify
        if (options.minifyHTML) {
          code = minifyHtml(code, {
            collapseWhitespace: true,
            keepClosingSlash: true,
            removeComments: true,
          });
        }

        fs.writeFileSync(file, code, 'utf-8');
        return;
      }
    }
  }

  return {
    name: '@snowpack/plugin-optimize',
    async optimize({buildDirectory}) {
      // 0. setup
      const esbuildService = await esbuild.startService();
      await init;
      let generatedFiles = [];

      // 1. index files
      const allFiles = glob
        .sync('**/*', {
          cwd: buildDirectory,
          ignore: [`${config.buildOptions.metaDir}/*`, ...((options && options.exclude) || [])],
          nodir: true,
        })
        .map((file) => path.join(buildDirectory, file)); // resolve to root dir

      // 2. scan imports
      const manifest = await scanHTML(
        allFiles.filter((f) => path.extname(f) === '.html'),
        buildDirectory,
      );

      // 3. optimize all files in parallel
      const parallelWorkQueue = new PQueue({concurrency: CONCURRENT_WORKERS});
      for (const file of allFiles.filter(
        (file) => (options.preloadCSS && !file.endsWith('.css.proxy.js')) || true, // if preloading CSS, don’t optimize .css.proxy.js files
      )) {
        parallelWorkQueue.add(() =>
          optimizeFile({
            file,
            esbuildService,
            rootDir: buildDirectory,
            target: options.target,
          }).catch((err) => {
            log(`Error: ${file} ${err.toString()}`, 'error');
          }),
        );
      }
      await parallelWorkQueue.onIdle();
      esbuildService.stop();

      // 5. build CSS file (and delete unneeded CSS )
      if (options.preloadCSS) {
        const combinedCSS = buildImportCSS(manifest, options.minifyCSS);
        if (combinedCSS) {
          const outputCSS = path.join(buildDirectory, options.combinedCSSName);
          await mkdirp(path.dirname(outputCSS));
          fs.writeFileSync(outputCSS, combinedCSS, 'utf-8');
          generatedFiles.push(outputCSS);
        }
      }

      // 6. wrte manifest
      fs.writeFileSync(
        path.join(buildDirectory, config.buildOptions.metaDir, 'optimize-manifest.json'),
        JSON.stringify(
          formatManifest({
            manifest,
            buildDirectory,
            generatedFiles,
            preloadCSS: options.preloadCSS,
          }),
          undefined,
          2,
        ),
        'utf-8',
      );
    },
  };
};
