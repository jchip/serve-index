/*!
 * serve-index
 * Copyright(c) 2011 Sencha Inc.
 * Copyright(c) 2011 TJ Holowaychuk
 * Copyright(c) 2014-2015 Douglas Christopher Wilson
 * MIT Licensed
 */

// support custom fs
// Existing PR https://github.com/expressjs/serve-index/pull/67/files

'use strict';

/**
 * Module dependencies.
 * @private
 */

var accepts = require('accepts');
var createError = require('http-errors');
var debug = require('debug')('serve-index');
var escapeHtml = require('escape-html');
var fs = require('fs');
var Batch = require('batch');
var mime = require('mime-types');
var parseUrl = require('parseurl');
var nativePathLib = require('path');


/**
 * Module exports.
 * @public
 */

module.exports = serveIndex;

module.exports.ServeIndex = ServeIndex;

/*!
 * Icon cache.
 */

var cache = {};

/*!
 * Default template.
 */

var defaultTemplate = nativePathLib.join(__dirname, 'public', 'directory.html');

/*!
 * Stylesheet.
 */

var defaultStylesheet = nativePathLib.join(__dirname, 'public', 'style.css');

/**
 * Media types and the map for content negotiation.
 */

var mediaTypes = [
  'text/html',
  'text/plain',
  'application/json'
];

var mediaType = {
  'text/html': 'html',
  'text/plain': 'plain',
  'application/json': 'json'
};

/**
 * Serve directory listings with the given `root` path.
 *
 * See Readme.md for documentation of options.
 *
 * @param {String} root
 * @param {Object} options
 * @return {Function} middleware
 * @public
 */

function ServeIndex(root, options) {
  var opts = options || {};

  // root required
  if (!root) {
    throw new TypeError('serveIndex() root path required');
  }

  // mainly for Windows to use posix() for MemFS
  this.pathLib = opts.path || nativePathLib;
  // resolve root to absolute and normalize
  this.rootPath = this.pathLib.normalize(this.pathLib.resolve(root) + this.pathLib.sep);
  // retreive other options
  this.filter = opts.filter;
  this.hidden = opts.hidden;
  this.showIcons = opts.icons;
  this.stylesheet = opts.stylesheet || defaultStylesheet;
  this.template = opts.template || defaultTemplate;
  this.view = opts.view || 'tiles';
  this.filesystem = opts.fs || fs; 
}

function serveIndex(root, options) {
  var instance = new ServeIndex(root, options);

  function serve(req, res, next) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.statusCode = 'OPTIONS' === req.method ? 200 : 405;
      res.setHeader('Allow', 'GET, HEAD, OPTIONS');
      res.setHeader('Content-Length', '0');
      res.end();
      return;
    }
  
    // parse URLs
    var url = parseUrl(req);
    var originalUrl = parseUrl.original(req);
    var dir = decodeURIComponent(url.pathname);
    var originalDir = decodeURIComponent(originalUrl.pathname);
  
    // join / normalize from root dir
    var path = this.pathLib.normalize(this.pathLib.join(this.rootPath, dir));
  
    // null byte(s), bad request
    if (~path.indexOf('\0')) return next(createError(400));
  
    // malicious path
    if ((path + this.pathLib.sep).substr(0, this.rootPath.length) !== this.rootPath) {
      debug('malicious path "%s"', path);
      return next(createError(403));
    }
  
    // determine ".." display
    var showUp = this.pathLib.normalize(this.pathLib.resolve(path) + this.pathLib.sep) !== this.rootPath;
  
    // check if we have a directory
    debug('stat "%s"', path);
    var _self = this;
    this.filesystem.stat(path, function(err, stat){
      if (err && err.code === 'ENOENT') {
        return next();
      }
  
      if (err) {
        err.status = err.code === 'ENAMETOOLONG'
          ? 414
          : 500;
        return next(err);
      }
  
      if (!stat.isDirectory()) return next();
  
      // fetch files
      debug('readdir "%s"', path);
      _self.filesystem.readdir(path, function(err, files){
        if (err) return next(err);
        if (!_self.hidden) files = _self.removeHidden(files);
        if (_self.filter) files = files.filter(function(filename, index, list) {
          return _self.filter(filename, index, list, path);
        });
        files.sort();
  
        // content-negotiation
        var accept = accepts(req);
        var type = accept.type(mediaTypes);
  
        // not acceptable
        if (!type) return next(createError(406));
        // find the relevant media-type to send the response
        var media = mediaType[type];
        var handlerContext = typeof serveIndex[media] === 'function' ? undefined : _self;
        (serveIndex[media] || _self[media]).call(handlerContext, req, res, files, next, originalDir, showUp, _self.showIcons, path, _self.view, _self.template, _self.stylesheet, _self.filesystem);
      });
    });
  }

  return function(req, res, next) {
    return serve.call(instance, req, res, next);
  }
}

/**
 * Respond with text/html.
 */
ServeIndex.prototype.html = function(req, res, files, next, dir, showUp, displayIcons, path, view, template, stylesheet, filesystem) {
  var render = typeof template !== 'function'
    ? this.createHtmlRender(template)
    : template

  if (showUp) {
    files.unshift('..');
  }

  var _self = this;
  // stat all files
  this.statFiles(path, files, filesystem, function (err, stats) {
    if (err) return next(err);

    // combine the stats into the file list
    var fileList = files.map(function (file, i) {
      return { name: file, stat: stats[i] };
    });

    // sort file list
    fileList.sort(_self.fileSort);

    // read stylesheet
    fs.readFile(stylesheet, 'utf8', function (err, style) {
      if (err) return next(err);

      // create locals for rendering
      var locals = {
        directory: dir,
        displayIcons: Boolean(displayIcons),
        fileList: fileList,
        path: path,
        style: style,
        viewName: view
      };

      // render html
      render(locals, function (err, body) {
        if (err) return next(err);
        _self.send(res, 'text/html', body)
      });
    });
  });
};

/**
 * Respond with application/json.
 */
ServeIndex.prototype.json = function(req, res, files) {
  this.send(res, 'application/json', JSON.stringify(files))
};

/**
 * Respond with text/plain.
 */
ServeIndex.prototype.plain = function(req, res, files) {
  this.send(res, 'text/plain', (files.join('\n') + '\n'))
};

/**
 * Map html `files`, returning an html unordered list.
 * @private
 */
ServeIndex.prototype.createHtmlFileList = function(files, dir, useIcons, view) {
  var _self = this;
  var html = '<ul id="files" class="view-' + escapeHtml(view) + '">'
    + (view === 'details' ? (
      '<li class="header">'
      + '<span class="name">Name</span>'
      + '<span class="size">Size</span>'
      + '<span class="date">Modified</span>'
      + '</li>') : '');

  html += files.map(function (file) {
    var classes = [];
    var isDir = file.stat && file.stat.isDirectory();
    var path = dir.split('/').map(function (c) { return encodeURIComponent(c); });

    if (useIcons) {
      classes.push('icon');

      if (isDir) {
        classes.push('icon-directory');
      } else {
        var ext = _self.pathLib.extname(file.name);
        var icon = _self.iconLookup(file.name);

        classes.push('icon');
        classes.push('icon-' + ext.substring(1));

        if (classes.indexOf(icon.className) === -1) {
          classes.push(icon.className);
        }
      }
    }

    path.push(encodeURIComponent(file.name));

    var date = file.stat && file.stat.mtime && file.name !== '..'
      ? file.stat.mtime.toLocaleDateString() + ' ' + file.stat.mtime.toLocaleTimeString()
      : '';
    var size = file.stat && !isDir
      ? file.stat.size
      : '';

    return '<li><a href="'
      + escapeHtml(_self.normalizeSlashes(_self.pathLib.normalize(path.join('/'))))
      + '" class="' + escapeHtml(classes.join(' ')) + '"'
      + ' title="' + escapeHtml(file.name) + '">'
      + '<span class="name">' + escapeHtml(file.name) + '</span>'
      + '<span class="size">' + escapeHtml(size) + '</span>'
      + '<span class="date">' + escapeHtml(date) + '</span>'
      + '</a></li>';
  }).join('\n');

  html += '</ul>';

  return html;
}

/**
 * Create function to render html.
 */
ServeIndex.prototype.createHtmlRender = function(template) {
  var _self = this;
  return function render(locals, callback) {
    // read template
    fs.readFile(template, 'utf8', function (err, str) {
      if (err) return callback(err);

      var body = str
        .replace(/\{style\}/g, locals.style.concat(_self.iconStyle(locals.fileList, locals.displayIcons)))
        .replace(/\{files\}/g, _self.createHtmlFileList(locals.fileList, locals.directory, locals.displayIcons, locals.viewName))
        .replace(/\{directory\}/g, escapeHtml(locals.directory))
        .replace(/\{linked-path\}/g, _self.htmlPath(locals.directory));

      callback(null, body);
    });
  };
}

/**
 * Sort function for with directories first.
 */
ServeIndex.prototype.fileSort = function(a, b) {
  // sort ".." to the top
  if (a.name === '..' || b.name === '..') {
    return a.name === b.name ? 0
      : a.name === '..' ? -1 : 1;
  }

  return Number(b.stat && b.stat.isDirectory()) - Number(a.stat && a.stat.isDirectory()) ||
    String(a.name).toLocaleLowerCase().localeCompare(String(b.name).toLocaleLowerCase());
}

/**
 * Map html `dir`, returning a linked path.
 */
ServeIndex.prototype.htmlPath = function(dir) {
  var parts = dir.split('/');
  var crumb = new Array(parts.length);

  for (var i = 0; i < parts.length; i++) {
    var part = parts[i];

    if (part) {
      parts[i] = encodeURIComponent(part);
      crumb[i] = '<a href="' + escapeHtml(parts.slice(0, i + 1).join('/')) + '">' + escapeHtml(part) + '</a>';
    }
  }

  return crumb.join(' / ');
}

/**
 * Get the icon data for the file name.
 */
ServeIndex.prototype.iconLookup = function(filename) {
  var ext = this.pathLib.extname(filename);

  // try by extension
  if (icons[ext]) {
    return {
      className: 'icon-' + ext.substring(1),
      fileName: icons[ext]
    };
  }

  var mimetype = mime.lookup(ext);

  // default if no mime type
  if (mimetype === false) {
    return {
      className: 'icon-default',
      fileName: icons.default
    };
  }

  // try by mime type
  if (icons[mimetype]) {
    return {
      className: 'icon-' + mimetype.replace('/', '-'),
      fileName: icons[mimetype]
    };
  }

  var suffix = mimetype.split('+')[1];

  if (suffix && icons['+' + suffix]) {
    return {
      className: 'icon-' + suffix,
      fileName: icons['+' + suffix]
    };
  }

  var type = mimetype.split('/')[0];

  // try by type only
  if (icons[type]) {
    return {
      className: 'icon-' + type,
      fileName: icons[type]
    };
  }

  return {
    className: 'icon-default',
    fileName: icons.default
  };
}

/**
 * Load icon images, return css string.
 */
ServeIndex.prototype.iconStyle = function(files, useIcons) {
  if (!useIcons) return '';
  var i;
  var list = [];
  var rules = {};
  var selector;
  var selectors = {};
  var style = '';

  for (i = 0; i < files.length; i++) {
    var file = files[i];

    var isDir = file.stat && file.stat.isDirectory();
    var icon = isDir
      ? { className: 'icon-directory', fileName: icons.folder }
      : this.iconLookup(file.name);
    var iconName = icon.fileName;

    selector = '#files .' + icon.className + ' .name';

    if (!rules[iconName]) {
      rules[iconName] = 'background-image: url(data:image/png;base64,' + this.load(iconName) + ');'
      selectors[iconName] = [];
      list.push(iconName);
    }

    if (selectors[iconName].indexOf(selector) === -1) {
      selectors[iconName].push(selector);
    }
  }

  for (i = 0; i < list.length; i++) {
    iconName = list[i];
    style += selectors[iconName].join(',\n') + ' {\n  ' + rules[iconName] + '\n}\n';
  }

  return style;
}

/**
 * Load and cache the given `icon`.
 *
 * @param {String} icon
 * @return {String}
 * @api private
 */
ServeIndex.prototype.load = function(icon) {
  if (cache[icon]) return cache[icon];
  return cache[icon] = fs.readFileSync(__dirname + '/public/icons/' + icon, 'base64');
}

/**
 * Normalizes the path separator from system separator
 * to URL separator, aka `/`.
 *
 * @param {String} path
 * @return {String}
 * @api private
 */
ServeIndex.prototype.normalizeSlashes = function(path) {
  return path.split(this.pathLib.sep).join('/');
};

/**
 * Filter "hidden" `files`, aka files
 * beginning with a `.`.
 *
 * @param {Array} files
 * @return {Array}
 * @api private
 */
ServeIndex.prototype.removeHidden = function(files) {
  return files.filter(function(file){
    return file[0] !== '.'
  });
}

/**
 * Send a response.
 * @private
 */
ServeIndex.prototype.send = function(res, type, body) {
  // security header for content sniffing
  res.setHeader('X-Content-Type-Options', 'nosniff')

  // standard headers
  res.setHeader('Content-Type', type + '; charset=utf-8')
  res.setHeader('Content-Length', Buffer.byteLength(body, 'utf8'))

  // body
  res.end(body, 'utf8')
}

/**
 * Stat all files and return array of stat
 * in same order.
 */
ServeIndex.prototype.statFiles = function(dir, files, filesystem, cb) {
  var batch = new Batch();
  batch.concurrency(10);

  var _self = this;
  files.forEach(function(file){
    batch.push(function(done){
      filesystem.stat(_self.pathLib.join(dir, file), function(err, stat){
        if (err && err.code !== 'ENOENT') return done(err);

        // pass ENOENT as null stat, not error
        done(null, stat || null);
      });
    });
  });

  batch.end(cb);
}

// custom response handlers
//  to be overridden when needed
serveIndex.html = null;
serveIndex.plain = null;
serveIndex.json = null;

/**
 * Icon map.
 */
var icons = {
  // base icons
  'default': 'page_white.png',
  'folder': 'folder.png',

  // generic mime type icons
  'font': 'font.png',
  'image': 'image.png',
  'text': 'page_white_text.png',
  'video': 'film.png',

  // generic mime suffix icons
  '+json': 'page_white_code.png',
  '+xml': 'page_white_code.png',
  '+zip': 'box.png',

  // specific mime type icons
  'application/javascript': 'page_white_code_red.png',
  'application/json': 'page_white_code.png',
  'application/msword': 'page_white_word.png',
  'application/pdf': 'page_white_acrobat.png',
  'application/postscript': 'page_white_vector.png',
  'application/rtf': 'page_white_word.png',
  'application/vnd.ms-excel': 'page_white_excel.png',
  'application/vnd.ms-powerpoint': 'page_white_powerpoint.png',
  'application/vnd.oasis.opendocument.presentation': 'page_white_powerpoint.png',
  'application/vnd.oasis.opendocument.spreadsheet': 'page_white_excel.png',
  'application/vnd.oasis.opendocument.text': 'page_white_word.png',
  'application/x-7z-compressed': 'box.png',
  'application/x-sh': 'application_xp_terminal.png',
  'application/x-msaccess': 'page_white_database.png',
  'application/x-shockwave-flash': 'page_white_flash.png',
  'application/x-sql': 'page_white_database.png',
  'application/x-tar': 'box.png',
  'application/x-xz': 'box.png',
  'application/xml': 'page_white_code.png',
  'application/zip': 'box.png',
  'image/svg+xml': 'page_white_vector.png',
  'text/css': 'page_white_code.png',
  'text/html': 'page_white_code.png',
  'text/less': 'page_white_code.png',

  // other, extension-specific icons
  '.accdb': 'page_white_database.png',
  '.apk': 'box.png',
  '.app': 'application_xp.png',
  '.as': 'page_white_actionscript.png',
  '.asp': 'page_white_code.png',
  '.aspx': 'page_white_code.png',
  '.bat': 'application_xp_terminal.png',
  '.bz2': 'box.png',
  '.c': 'page_white_c.png',
  '.cab': 'box.png',
  '.cfm': 'page_white_coldfusion.png',
  '.clj': 'page_white_code.png',
  '.cc': 'page_white_cplusplus.png',
  '.cgi': 'application_xp_terminal.png',
  '.cpp': 'page_white_cplusplus.png',
  '.cs': 'page_white_csharp.png',
  '.db': 'page_white_database.png',
  '.dbf': 'page_white_database.png',
  '.deb': 'box.png',
  '.dll': 'page_white_gear.png',
  '.dmg': 'drive.png',
  '.docx': 'page_white_word.png',
  '.erb': 'page_white_ruby.png',
  '.exe': 'application_xp.png',
  '.fnt': 'font.png',
  '.gam': 'controller.png',
  '.gz': 'box.png',
  '.h': 'page_white_h.png',
  '.ini': 'page_white_gear.png',
  '.iso': 'cd.png',
  '.jar': 'box.png',
  '.java': 'page_white_cup.png',
  '.jsp': 'page_white_cup.png',
  '.lua': 'page_white_code.png',
  '.lz': 'box.png',
  '.lzma': 'box.png',
  '.m': 'page_white_code.png',
  '.map': 'map.png',
  '.msi': 'box.png',
  '.mv4': 'film.png',
  '.pdb': 'page_white_database.png',
  '.php': 'page_white_php.png',
  '.pl': 'page_white_code.png',
  '.pkg': 'box.png',
  '.pptx': 'page_white_powerpoint.png',
  '.psd': 'page_white_picture.png',
  '.py': 'page_white_code.png',
  '.rar': 'box.png',
  '.rb': 'page_white_ruby.png',
  '.rm': 'film.png',
  '.rom': 'controller.png',
  '.rpm': 'box.png',
  '.sass': 'page_white_code.png',
  '.sav': 'controller.png',
  '.scss': 'page_white_code.png',
  '.srt': 'page_white_text.png',
  '.tbz2': 'box.png',
  '.tgz': 'box.png',
  '.tlz': 'box.png',
  '.vb': 'page_white_code.png',
  '.vbs': 'page_white_code.png',
  '.xcf': 'page_white_picture.png',
  '.xlsx': 'page_white_excel.png',
  '.yaws': 'page_white_code.png'
};
