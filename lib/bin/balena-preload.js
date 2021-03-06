#!/usr/bin/env node

'use strict';

const Docker = require('dockerode');
const preload = require('../preload');
// @ts-expect-error
const info = require('../../package.json');
const Promise = require('bluebird');
const balenaSdk = require('balena-sdk');
const tmp = Promise.promisifyAll(require('tmp'));
const visuals = require('resin-cli-visuals');
const nodeCleanup = require('node-cleanup');

tmp.setGracefulCleanup();

const USAGE = `
  Usage: ${info.name} [options]

  Options:

    --app            Application ID (required)
    --img            Disk image (or zip file for Edison images) to preload into (required)
    --api-token      API token (required, or api-key)
    --api-key        API key (required, or api-token)
    --commit         Application commit to preload (default: latest)
    --splash-image   PNG Image for custom splash screen

    --dont-check-arch          Disables check for matching architecture in image and application

    --add-certificate <filename.crt> Adds the given file to /etc/ssl/certs in the preloading container

    --help, -h       Display ${info.name} usage
    --version, -v    Display ${info.name} version

  Environment variables:

    BALENARC_BALENA_URL (defaults to balena-cloud.com)

    The following option flags can also be set
    via the corresponding environment variables:

    --app                               APP_ID
    --img                               IMAGE
    --api-token                         API_TOKEN
    --api-key                           API_KEY
    --commit                            COMMIT
    --splash-image                      SPLASH_IMAGE
    --dont-check-arch                   DONT_CHECK_ARCH

  Example:

    ${info.name} --app 123456 --api-token "xxxx..." --img /path/to/balena-os.img
`;

const inspect = (value) => {
	return require('util').inspect(value, {
		colors: process.stdout.isTTY,
	});
};

const showError = (error) => {
	console.error(
		`\n${inspect(error)}\n\nLooks like this might be an issue with ${
			info.name
		}. Please report it at ${info.bugs.url}`,
	);
};

const handleError = (error) => {
	const code = typeof error.code === 'number' ? error.code || 1 : 1;
	showError(error);
	process.exit(code);
};

process.on('uncaughtException', handleError);

const argv = process.argv.slice(2);

if (argv.indexOf('--help') !== -1 || argv.indexOf('-h') !== -1) {
	console.log(USAGE);
	process.exit(0);
}

if (argv.indexOf('--version') !== -1 || argv.indexOf('-v') !== -1) {
	console.log(info.version);
	process.exit(0);
}

const getBalenaSdk = (opts) => {
	// Creates a temporary directory for balena sdk so it won't replace any existing token.
	const balenaSdkOptions = { apiKey: opts.apiKey };
	if (process.env.RESINRC_RESIN_URL !== undefined) {
		balenaSdkOptions.apiUrl = 'https://api.' + process.env.RESINRC_RESIN_URL;
	}
	if (process.env.BALENARC_BALENA_URL !== undefined) {
		balenaSdkOptions.apiUrl = 'https://api.' + process.env.BALENARC_BALENA_URL;
	}
	// @ts-expect-error bluebird promisify
	return tmp.dirAsync({ unsafeCleanup: true }).spread((path) => {
		balenaSdkOptions.dataDirectory = path;
		// @ts-expect-error
		const balena = balenaSdk(balenaSdkOptions);
		if (opts.apiToken) {
			return balena.auth.loginWithToken(opts.apiToken).return(balena);
		}
		return balena;
	});
};

const options = {
	appId: process.env['APP_ID'],
	image: process.env['IMAGE'],
	apiToken: process.env['API_TOKEN'],
	apiKey: process.env['API_KEY'],
	commit: process.env['COMMIT'],
	splashImage: process.env['SPLASH_IMAGE'],
	dontCheckArch: !!process.env['DONT_CHECK_ARCH'],
	certificates: [],
};

while (argv.length) {
	switch (argv.shift()) {
		case '--app':
			// @ts-expect-error ignoring possible null
			options.appId = parseInt(argv.shift(), 10);
			break;
		case '--img':
			options.image = argv.shift();
			break;
		case '--api-token':
			options.apiToken = argv.shift();
			break;
		case '--api-key':
			options.apiKey = argv.shift();
			break;
		case '--commit':
			options.commit = argv.shift();
			break;
		case '--splash-image':
			options.splashImage = argv.shift();
			break;
		case '--dont-check-arch':
			options.dontCheckArch = true;
			break;
		case '--add-certificate':
			// @ts-expect-error ignoring possible null
			options.certificates.push(argv.shift());
			break;
	}
}

// Show usage help if no options have been set
if (!(options.appId && options.image && (options.apiToken || options.apiKey))) {
	console.error(USAGE);
	process.exit(1);
}

const progressBars = {};

const progressHandler = (event) => {
	let progressBar = progressBars[event.name];
	if (!progressBar) {
		progressBar = progressBars[event.name] = new visuals.Progress(event.name);
	}
	progressBar.update({ percentage: event.percentage });
};

const spinners = {};

const spinnerHandler = (event) => {
	let spinner = spinners[event.name];
	if (!spinner) {
		spinner = spinners[event.name] = new visuals.Spinner(event.name);
	}
	if (event.action === 'start') {
		spinner.start();
	} else {
		// Output an empty line so the spinner doesn't get erased
		console.log();
		spinner.stop();
	}
};

let gotSignal = false;

getBalenaSdk(options).then((balena) => {
	const preloader = new preload.Preloader(
		balena,
		// @ts-expect-error bluebird and promise types don't quite match 100%
		new Docker({ Promise }),
		options.appId,
		options.commit,
		options.image,
		options.splashImage,
		options.proxy,
		options.dontCheckArch,
		false,
		options.certificates,
	);

	if (process.env.DEBUG) {
		preloader.stderr.pipe(process.stderr);
	}

	preloader.on('progress', progressHandler);
	preloader.on('spinner', spinnerHandler);

	nodeCleanup((_exitCode, signal) => {
		if (signal) {
			gotSignal = true;
			nodeCleanup.uninstall(); // don't call cleanup handler again
			preloader.cleanup().then(() => {
				// calling process.exit() won't inform parent process of signal
				process.kill(process.pid, signal);
			});
			return false;
		}
	});

	return new Promise((resolve, reject) => {
		preloader.on('error', (err) => {
			reject(err);
		});

		return preloader
			.prepare()
			.then(() => {
				return preloader.preload();
			})
			.then(resolve)
			.catch(reject);
	})
		.finally(() => {
			if (!gotSignal) {
				return preloader.cleanup();
			}
		})
		.catch(balena.errors.BalenaError, (err) => {
			console.error('Error:', err.message);
			process.exitCode = 1;
		})
		.catch(handleError);
});
