'use strict';

const ProxyReporter = require('./proxy-reporter');
const logger = require('../../utils').logger;
const Skip = require('./skip/');
const SkipBuilder = require('./skip/skip-builder');
const OnlyBuilder = require('./skip/only-builder');
const Mocha = require('mocha');
const path = require('path');
const clearRequire = require('clear-require');
const q = require('q');
const _ = require('lodash');

// Avoid mochajs warning about possible EventEmitter memory leak
// https://nodejs.org/docs/latest/api/events.html#events_emitter_setmaxlisteners_n
// Reason: each mocha runner sets 'uncaughtException' listener
process.setMaxListeners(0);

const isSkipped = (suite) => {
    return _.every(suite.suites, (s) => isSkipped(s))
        && _.every(suite.tests, 'pending');
};

module.exports = class MochaAdapter {
    static create(opts, browserAgent) {
        return new MochaAdapter(opts, browserAgent);
    }

    constructor(opts, browserAgent) {
        this._mocha = new Mocha(opts);
        this._mocha.fullTrace();
        this.suite = this._mocha.suite;

        this._browserAgent = browserAgent;
        this._browser = null;

        this._currentRunnable = null;

        this._injectBrowser();
        this._injectSkip();
        this._injectRunnableSpy();
    }

    applySkip(testSkipper) {
        testSkipper.applySkip(this.suite, this._browserAgent.browserId);

        return this;
    }

    addFiles(files) {
        files.forEach((file) => {
            clearRequire(path.resolve(file));
            this._mocha.addFile(file);
        });

        this._mocha.loadFiles();
        this._mocha.files = [];

        return this;
    }

    attachTitleValidator(titles) {
        this._addEventHandler('test', (test) => {
            const fullTitle = test.fullTitle();

            if (titles[fullTitle]) {
                throw new Error(`Cannot use tests with the same title: '${fullTitle}'` +
                    ` in file: '${titles[fullTitle]}'`);
            }

            titles[fullTitle] = path.relative(process.cwd(), test.file);
        });

        return this;
    }

    attachTestFilter(shouldRunTest) {
        shouldRunTest = shouldRunTest || (() => true);

        const browserId = this._browserAgent.browserId;

        this._addEventHandler('test', (test) => shouldRunTest(test, browserId) || test.parent.tests.pop());

        return this;
    }

    attachEmitFn(emit) {
        const Reporter = _.partial(ProxyReporter, emit, () => this._getBrowser());
        this._mocha.reporter(Reporter);

        return this;
    }

    run() {
        return q.Promise(this._mocha.run.bind(this._mocha));
    }

    _injectSkip() {
        const skip = new Skip();

        this.suite.on('pre-require', () => {
            const skipBuilder = new SkipBuilder(skip, this._browserAgent.browserId);
            const onlyBuilder = new OnlyBuilder(skipBuilder);

            global.hermione = {
                skip: skipBuilder,
                only: onlyBuilder
            };
        });

        this.suite.on('post-require', () => delete global.hermione);

        this._addEventHandler(['suite', 'test'], (runnable) => skip.handleEntity(runnable));
    }

    _injectRunnableSpy() {
        const browserId = this._browserAgent.browserId;

        this._addEventHandler(
            ['beforeAll', 'beforeEach', 'test', 'afterEach', 'afterAll'],
            (runnable) => {
                const baseFn = runnable.fn;
                if (!baseFn) {
                    return;
                }

                const _this = this;
                runnable.fn = function() {
                    _this._currentRunnable = _.extend(runnable, {browserId});
                    return baseFn.apply(this, arguments);
                };
            }
        );
    }

    // Set recursive handler for events triggered by mocha while parsing test file
    _addEventHandler(events, cb) {
        events = [].concat(events);

        const listenSuite = (suite) => {
            suite.on('suite', listenSuite);
            events.forEach((e) => suite.on(e, cb));
        };

        listenSuite(this.suite);
    }

    _injectBrowser() {
        const savedEnableTimeouts = this.suite.enableTimeouts();

        this.suite.enableTimeouts(false);

        this.suite.beforeAll(() => this._requestBrowser());
        this.suite.afterAll(() => this._freeBrowser());

        this.suite.enableTimeouts(savedEnableTimeouts);
    }

    _requestBrowser() {
        if (isSkipped(this.suite)) {
            return;
        }

        return this._browserAgent.getBrowser()
            .then((browser) => {
                this._browser = browser;

                Object.defineProperty(Object.getPrototypeOf(browser.publicAPI), 'executionContext', {
                    get: () => this._currentRunnable
                });

                this.suite.ctx.browser = browser.publicAPI;
            });
    }

    _freeBrowser() {
        return this._browser
            && this._browserAgent.freeBrowser(this._browser)
                .catch((e) => logger.warn('WARNING: can not release browser: ' + e));
    }

    _getBrowser() {
        return this._browser || {id: this._browserAgent.browserId};
    }
};
