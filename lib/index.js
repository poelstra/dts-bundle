'use strict';

/* jshint -W098*/
/* jshint -W083*/

var os = require('os');
var fs = require('fs');
var path = require('path');
var util = require('util');
var assert = require('assert');
var glob = require('glob');
var detectIndent = require('detect-indent');
var pkg = require('../package');

var dtsExp = /\.d\.ts$/;
var bomOptExp = /^\uFEFF?/;

var externalExp = /^([ \t]*declare module )(['"])(.+?)(\2[ \t]*{?.*)$/;
var importExp = /^([ \t]*(?:export )?(?:import .+? )= require\()(['"])(.+?)(\2\);.*)$/;
var referenceTagExp = /^[ \t]*\/\/\/[ \t]*<reference[ \t]+path=(["'])(.*?)\1?[ \t]*\/>.*$/;
var identifierExp = /^\w+(?:[\.-]\w+)*$/;
var fileExp = /^([\./].*|.:.*)$/;
var privateExp = /^[ \t]*(?:static )?private (?:static )?/;
var publicExp = /^([ \t]*)(static |)(public )(static |)(.*)/;

var verbose; // true / false, set later by options

function trace(/* msg, ...args */) {
	if (verbose) {
		var args = Array.prototype.slice.call(arguments);
		console.log(util.format.apply(null, args));
	}
}

function pushUnique(arr, value) {
	if (arr.indexOf(value) < 0) {
		arr.push(value);
	}
	return arr;
}

function pushUniqueArr(arr, values) {
	for (var a = 1; a < arguments.length; a++) {
		var tmp = arguments[a];
		for (var i = 0, ii = tmp.length; i < ii; i++) {
			var v = tmp[i];
			if (arr.indexOf(v) < 0) {
				arr.push(v);
			}
		}
	}
	return arr;
}

function formatReference(file) {
	return '/// <reference path="' + file.replace(/\\/g, '/') + '" />';
}

function extractReference(tag) {
	var match = tag.match(referenceTagExp);
	if (match) {
		return match[2];
	}
	return null;
}

function replaceImportExport(line, replacer) {
	var match = line.match(importExp);
	if (match) {
		assert(match[4]);
		if (identifierExp.test(match[3])) {
			return match[1] + match[2] + replacer(match[3]) + match[4];
		}
	}
	return line;
}

function replaceExternal(line, replacer) {
	var match = line.match(externalExp);
	if (match) {
		assert(match[4]);
		if (identifierExp.test(match[3])) {
			return match[1] + match[2] + replacer(match[3]) + match[4];
		}
	}
	return line;
}

function getIndenter(actual, use) {
	if (actual === use || !actual) {
		return function (line) {
			return String(line);
		};
	}
	return function (line) {
		return String(line).replace(new RegExp('^' + actual + '+', 'g'), function (match) {
			return match.split(actual).join(use);
		});
	};
}

function optValue(passed, def) {
	if (typeof passed === 'undefined') {
		return def;
	}
	return passed;
}

function regexEscape(s) {
    return s.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
}

function bundle(options) {
	assert(typeof options === 'object' && options, 'options must be an object');

	// option parsing & validation
	var main = options.main;
	var exportName = options.name;
	var baseDir = optValue(options.baseDir, path.dirname(options.main));
	var out = optValue(options.out, exportName + '.d.ts');
	var newline = optValue(options.newline, os.EOL);
	var indent = optValue(options.indent, '    ');
	var prefix = optValue(options.prefix, '__');
	var separator = optValue(options.separator, '/');
	var includeExternal = optValue(options.includeExternal, false);
	var excludeTypingsExp = optValue(options.excludeTypingsExp, null);
	var deleteSourceTypings = optValue(options.deleteSourceTypings, false);
	verbose = optValue(options.verbose, false);

	assert.ok(main, 'option "main" must be defined');
	assert.ok(exportName, 'option "name" must be defined');

	assert(typeof newline === 'string', 'option "newline" must be a string');
	assert(typeof indent === 'string', 'option "indent" must be a string');
	assert(typeof prefix === 'string', 'option "prefix" must be a string');
	assert(separator.length > 0, 'option "separator" must have non-zero length');

	// turn relative paths into absolute paths
	baseDir = path.resolve(baseDir);
	var mainFile = path.resolve(baseDir, main.replace(/\//g, path.sep));
	var outFile = path.resolve(baseDir, out.replace(/\//g, path.sep));

	if (!excludeTypingsExp) {
		// Exclude our own output file by default, unless we're replacing the main file
		if (mainFile !== outFile) {
			excludeTypingsExp = new RegExp('^' + regexEscape(out) + '$');
		} else {
			excludeTypingsExp = new RegExp('^$'); // match nothing
		}
	}

	trace('### settings ###');
	trace('name:     %s', exportName);
	trace('baseDir:  %s', baseDir);
	trace('mainFile: %s', mainFile);
	trace('outFile:  %s', outFile);
	trace('includeExternal: %s', includeExternal ? 'yes' : 'no');
	trace('excludeTypingsExp: %s', excludeTypingsExp);
	trace('deleteSourceTypings: %s', deleteSourceTypings ? 'yes' : 'no');

	assert(fs.existsSync(mainFile), 'main does not exist: ' + mainFile);

	// Build a list of all typings that we found, and split them into
	// internal (stuff that should be included in our bundled typing) and
	// external typings (stuff that we expect others to provide themselves,
	// e.g. node.d.ts).
	trace('\n### find typings ###');
	var sourceTypings = [];
	var excludedTypings = [];
	var allTypings = glob.sync('**/*.d.ts', {
		cwd: baseDir
	}).map(function (file) {
		if (excludeTypingsExp.test(file)) {
				excludedTypings.push(file);
		} else {
				sourceTypings.push(file);
		}
	});

	// Turn internal and external typings into absolute paths,
	// and build fast lookup maps.
	var sourceTypingsMap = {};
	trace('source typings (will be included in output if actually used)');
	sourceTypings = sourceTypings.map(function (file) {
		var p = path.resolve(baseDir, file);
		trace(' - %s (%s)', file, p);
		sourceTypingsMap[p] = true;
		return p;
	});
	var excludedTypingsMap = {};
	trace('excluded typings (will always be excluded from output)');
	excludedTypings = excludedTypings.map(function (file) {
		var p = path.resolve(baseDir, file);
		trace(' - %s (%s)', file, p);
		excludedTypingsMap[p] = true;
		return p;
	});

	// auto-discovered external typings
	var externalTypings = [];
	var externalTypingsMap = {};

	// enclosed helpers
	function getModName(file) {
		return path.relative(baseDir, path.dirname(file) + path.sep + path.basename(file).replace(/\.d\.ts$/, ''));
	}

	function getExpName(file) {
		var isMain = (file === mainFile);
		if (isMain) {
			return exportName;
		}
		return getExpNameRaw(file);
	}

	function getExpNameRaw(file) {
		return prefix + exportName + separator + cleanupName(getModName(file));
	}

	function getLibName(ref) {
		return getExpNameRaw(mainFile) + separator + prefix + separator + ref;
	}

	function cleanupName(name) {
		return name.replace(/\.\./g, '--').replace(/[\\\/]/g, separator);
	}

	function getReferenceBundle(bundle, refs) {
		var base = path.basename(bundle);
		return refs.map(function (ref) {
			return formatReference(path.relative(base, ref));
		}).join(newline) + newline;
	}

	function formatModule(file, lines) {
		var out = '';
		out += 'declare module \'' + getExpName(file) + '\' {' + newline;
		out += (lines.length === 0 ? '' : indent + lines.join(newline + indent)) + newline;
		out += '}' + newline;
		return out;
	}

	// main info extractor
	function parseFile(file) {
		var name = getModName(file);

		trace('%s (%s)', name, file);

		var code = fs.readFileSync(file, 'utf8').replace(bomOptExp, '').replace(/\s*$/, '');

		var res = {
			file: file,
			name: name,
			indent: detectIndent(code) || indent,
			exp: getExpName(file),
			refs: [], // triple-slash references
			externalImports: [], // import()'s like "events"
			relativeImports: [], // import()'s like "./foo"
			exports: [],
			lines: [],
			// the next two properties contain single-element arrays, which reference the same
			// single-element in .lines, in order to be able to replace their contents later
			// in the bundling process.
			importLineRef: [],
			relativeRef: []
		};

		code.split(/\r?\n/g).forEach(function (line) {
			// blankline
			if (/^\s*$/.test(line)) {
				res.lines.push('');
				return;
			}
			// reference tag
			if (/^\/\/\//.test(line)) {
				var ref = extractReference(line);
				if (ref) {
					var refPath = path.resolve(path.dirname(file), ref);
					if (sourceTypingsMap[refPath]) {
						trace(' - reference source typing %s (%s)', ref, refPath);
					} else {
						var relPath = path.relative(baseDir, refPath).replace(/\\/g, '/'); // Ensure a relative path, with unix line-endings, for easy regex matching
						if (excludedTypingsMap[refPath] || (!externalTypingsMap[refPath] && excludeTypingsExp.test(relPath))) {
							trace(' - reference excluded typing %s (%s) (relative: %s)', ref, refPath, relPath);
							if (!excludedTypingsMap[refPath]) {
								excludedTypings.push(refPath);
								excludedTypingsMap[refPath] = true;
							}
						} else {
							trace(' - reference external typing %s (%s) (relative: %s)', ref, refPath, relPath);
							if (!externalTypingsMap[refPath]) {
								externalTypings.push(refPath);
								externalTypingsMap[refPath] = true;
							}
						}
					}
					pushUnique(res.refs, refPath);
					return;
				}
			}
			// private member
			if (privateExp.test(line)) {
				return;
			}

			var match;

			// import() statement
			if ((match = line.match(importExp))) {
				assert(match[3]);

				var impPath = path.resolve(path.dirname(file), match[3]);

				// filename (i.e. starts with a dot, slash or windows drive letter)
				if (fileExp.test(match[3])) {
					// TODO: some module replacing is handled here, whereas the rest is
					// done in the "rewrite global external modules" step. It may be
					// more clear to do all of it in that step.
					var expName = getExpName(impPath);
					line = [match[1] + match[2] + expName + match[4]];
					res.lines.push(line);

					var full = path.resolve(path.dirname(file), impPath + '.d.ts');
					trace(' - import relative %s (%s)', match[3], full);
					pushUnique(res.relativeImports, full);
					res.importLineRef.push(line);
				}
				// identifier
				else {
					line = [line];
					res.lines.push(line);
					trace(' - import external %s', match[3]);
					pushUnique(res.externalImports, match[3]);
					if (includeExternal) {
						res.importLineRef.push(line);
					}
				}
			}
			// declaring an external module
			// this triggers when we're e.g. parsing external module declarations, such as node.d.ts
			else if ((match = line.match(externalExp))) {
				assert(match[3]);

				trace(' - declare %s', match[3]);
				pushUnique(res.exports, match[3]);
				line = [line];
				res.relativeRef.push(line);
				res.lines.push(line);
			}
			// clean regular lines
			else {
				// remove public keyword
				if ((match = line.match(publicExp))) {
					line = match[1] + match[2] + match[4] + match[5];
				}
				if (sourceTypingsMap[file]) {
					// For internal typings, remove the 'declare' keyword (but leave 'export' intact)
					res.lines.push(line.replace(/^(export )?declare /g, '$1'));
				}
				else {
					res.lines.push(line);
				}
			}
		});

		return res;
	}

	// recursively parse files, starting from main file,
	// following all references and imports (including external, but excluding excludedTypings),
	// in order to have a good overview of in which typings-file an
	// external module is actually defined.
	trace('\n### parse files ###');

	var queue = [mainFile];
	var queueSeen = {};
	var fileMap = {};
	var mainParse; // will be parsed result of first parsed file
	var parse; // temp var
	while (queue.length > 0) {
		var target = queue.shift();
		if (queueSeen[target]) {
			continue;
		}
		queueSeen[target] = true;

		if (excludedTypingsMap[target]) {
			continue;
		}

		// parse the file
		parse = parseFile(target);
		if (!mainParse) {
			mainParse = parse;
		}
		fileMap[parse.file] = parse;
		pushUniqueArr(queue, parse.refs, parse.relativeImports);
	}

	// map all exports to their file
	trace('\n### map exports ###');
	var exportMap = {};
	Object.keys(fileMap).forEach(function (file) {
		parse = fileMap[file];
		parse.exports.forEach(function (name) {
			assert(!(name in exportMap), 'already got export for: ' + name);
			exportMap[name] = parse;
			trace('- %s -> %s', name, parse.file);
		});
	});

	// build list of typings to include in output later
	trace('\n### determine typings to include ###');
	queue = [mainParse];
	queueSeen = {};
	var usedTypings = [];
	var externalDependencies = []; // lists all source files that we omit due to !includeExternal
	while (queue.length > 0) {
		parse = queue.shift();
		if (queueSeen[parse.file]) {
			continue;
		}
		queueSeen[parse.file] = true;

		trace('%s (%s)', parse.name, parse.file);
		usedTypings.push(parse);
		parse.externalImports.forEach(function (name) {
			var p = exportMap[name];
			if (excludedTypingsMap[p.file] || !includeExternal) {
				trace(' - exclude external %s', name);
				pushUnique(externalDependencies, p.file);
				return;
			}
			trace(' - include external %s', name);
			queue.push(p);
		});
		parse.relativeImports.forEach(function (file) {
			var p = fileMap[file];
			trace(' - import relative %s', file);
			queue.push(p);
		});
	}

	// rewrite global external modules to a unique name
	trace('\n### rewrite global external modules ###');
	usedTypings.forEach(function (parse) {
		trace(parse.name);
		parse.relativeRef.forEach(function (line, i) {
			var replaced = replaceExternal(String(line), getLibName);
			trace(' - %s  ==>  %s', line, replaced);
			parse.relativeRef[i][0] = replaced;
		});
		parse.importLineRef.forEach(function (line, i) {
			var replaced = replaceImportExport(String(line), getLibName);
			trace(' - %s  ==>  %s', line, replaced);
			parse.importLineRef[i][0] = replaced;
		});
	});

	// build collected content
	trace('\n### build output ###');
	var content = '';
	content += '// Generated by dts-bundle ' + pkg.version + '\n';
	if (externalDependencies.length > 0) {
		content += '// Dependencies for this module:\n';
		externalDependencies.forEach(function(file) {
			content += '//   ' + path.relative(baseDir, file).replace(/\\/g, '/') + '\n';
		});
	}
	content += '\n';
	// content += header.stringify(header.importer.packageJSON(pkg)).join(lb) + lb;
	// content += lb;

	// add wrapped modules to output
	var used = [];
	content += usedTypings.map(function (parse) {
		used.push(parse.file);
		if (sourceTypingsMap[parse.file]) {
			return formatModule(parse.file, parse.lines.map(getIndenter(parse.indent, indent)));
		}
		else {
			return parse.lines.map(getIndenter(parse.indent, indent)).join(newline) + newline;
		}
	}).join(newline) + newline;

	// remove internal typings, except the 'regenerated' main typing
	if (deleteSourceTypings) {
		trace('\n### remove source typings ###');
		sourceTypings.map(function (p) {
			// safety check, only delete .d.ts files, leave our outFile intact for now
			if (p !== outFile && dtsExp.test(p) && fs.statSync(p).isFile()) {
				trace(' - %s', p);
				fs.unlinkSync(p);
			}
		});
	}

	// write main file
	trace('\n### write output ###');
	trace(outFile);
	fs.writeFileSync(outFile, content, 'utf8');

	// print some debug info
	if (verbose) {
		trace('\n### statistics ###');
		trace('used sourceTypings');
		sourceTypings.forEach(function (p) {
			if (used.indexOf(p) > -1) {
				trace(' - %s', p);
			}
		});
		trace('unused sourceTypings');
		sourceTypings.forEach(function (p) {
			if (used.indexOf(p) < 0) {
				trace(' - %s', p);
			}
		});
		trace('excludedTypings');
		excludedTypings.forEach(function (p) {
			trace(' - %s', p);
		});
		trace('used external typings');
		externalTypings.forEach(function(p) {
			if (used.indexOf(p) > -1) {
				trace(' - %s', p);
			}
		});
		trace('unused external typings');
		externalTypings.forEach(function(p) {
			if (used.indexOf(p) < 0) {
				trace(' - %s', p);
			}
		});
		trace('external dependencies');
		externalDependencies.forEach(function(p) {
			trace(' - %s', p);
		});
	}

	trace('\n### done ###\n');
}

module.exports = {
	bundle: bundle
};
