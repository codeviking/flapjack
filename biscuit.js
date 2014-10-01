var fs = require('fs');
var q = require('q');
var util = require('util');
var path = require('path');
var rimraf = require('rimraf');
var cp = require('child_process');
var butil = require('biscuit-util');

function loadPaths(src) {
  var pathsFile = path.resolve(src, 'paths.js');

  if(!fs.existsSync(pathsFile) || !fs.statSync(pathsFile).isFile()) {
    throw util.format('Paths file %s doesn\'t exist', pathsFile);
  }

  var paths = require(pathsFile);
  Object.getOwnPropertyNames(paths).forEach(function(name) {
    paths[name] = path.resolve(src, paths[name]);
  });

  if(!paths.SRC || !fs.existsSync(paths.SRC) || !fs.statSync(paths.SRC).isDirectory()) {
    throw util.format('Invalid source path %s', paths.SRC);
  }
  if(!paths.BUILD || !fs.existsSync(paths.BUILD) || !fs.statSync(paths.BUILD).isDirectory()) {
    throw util.format('Invalid build path %s', paths.BUILD);
  }
  if(!paths.SRC || !fs.existsSync(paths.VAR) || !fs.statSync(paths.VAR).isDirectory()) {
    throw util.format('Invalid var path %s', paths.VAR);
  }
  return paths;
};

function Biscuit(base) {
  if(!base || !fs.existsSync(base) || !fs.statSync(base).isDirectory()) {
    throw util.format('Invalid directory: %s', base.magenta);
  }
  this.base = base;
  this.paths = loadPaths(base);
};

Biscuit.prototype.pidFile = function() {
  return path.resolve(this.paths.VAR, 'oven.pid');
};

Biscuit.prototype.pid = function(pid) {
  var file = this.pidFile();
  if(typeof pid !== 'undefined' && !this.isServerRunning()) {
    fs.writeFileSync(file, pid);
  }
  return fs.existsSync(file) && fs.readFileSync(file).toString();
};

Biscuit.prototype.isServerRunning = function() {
  var pid = this.pid();
  if(!pid) {
    return false;
  }
  // Send signal 0 to the pid, which doesn't try to kill it.  Instead, if
  // this fails it'll throw an exception meaning the process doesn't
  // exist.
  try {
    return process.kill(pid, 0);
  } catch(e) {
    return e.code === 'EPERM';
  }
};

Biscuit.prototype.startServer = function(port) {
  var started = q.defer();
  if(!this.isServerRunning()) {
    // Spawn the "oven" (our http server)
    var p = cp.fork(path.resolve(__dirname, 'oven/index.js'),
        [ this.base, port ]);

    // Write the pid out to a pid file
    this.pid(p.pid);

    // Wait for the SERVER_STARTED message from the child process, which
    // indicates the server is up and running.
    p.on('message', function(m) {
      if(m === 'SERVER_STARTED') {
        started.resolve();
      }
    });

    // The error event occurs if we're unable to start the process
    // for some reason.
    p.on('error', function(err) {
      fs.unlinkSync(getPidFilePath(src, paths));
      started.reject(util.format(
            'Error encountered while attempting to start Server : %s',
            err
          )
        );
    });

    // If the process shutsdown unexpectadly, reject the promise.
    p.on('close', function(code, signal) {
      fs.unlinkSync(getPidFilePath(src, paths));
      started.reject(
          util.format(
            'Server unexpectantly shut down. Code: %s, Signal: %s',
            code,
            signal
          )
        );
    });
  } else {
    started.reject(util.format('Server is already running with pid: %s',
        this.pid()));
  }
  return started.promise;
};

Biscuit.prototype.stopServer = function() {
  var stopped = q.defer();
  if(this.isServerRunning()) {
    try {
      process.kill(this.pid(), 'SIGTERM');
    } catch(e) {
      stopped.reject(e);
    }
    fs.unlinkSync(this.pidFile());
    stopped.resolve('Server stopped.');
  } else {
    stopped.reject('Server isn\'t running');
  }
  return stopped.promise;
};

Biscuit.prototype.isBaking = function() {
  return this.baking && this.baking.promise && this.baking.promise.isPending();
};

Biscuit.prototype.bake = function() {
  if(!this.isBaking()) {
    this.baking = q.defer();
    var g = cp.spawn('gulp', [ '--baking' ], { cwd: this.base });

    var err = '';
    g.stderr.on('data', function(d) {
      err += d;
    });

    g.on('error', function(e) {
      this.baking.reject(
        new butil.GulpTaskError({
          task: 'gulp',
          message: 'Error Executing Gulp Build',
          extra: e
        })
      );
    }.bind(this));

    g.on('close', function() {
      if(err) {
        try {
          err = new butil.GulpTaskError(JSON.parse(err));
        } catch(e) {}
        this.baking.reject(err);
      } else {
        this.baking.resolve()
      }
    }.bind(this));
  }
  return this.baking.promise;
};

module.exports = Biscuit;
