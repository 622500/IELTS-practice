const path = require('node:path');
const express = require('express');
const session = require('express-session');
const connectPgSimple = require('connect-pg-simple');
const helmet = require('helmet');

const db = require('./db');
const { PostgresAuthStore, createAuthRouter } = require('./auth');
const { PostgresPracticeRecordStore, createPracticeRecordsRouter } = require('./practiceRecords');

const DEFAULT_SESSION_SECRET = 'development-session-secret-change-me';
const PLACEHOLDER_SESSION_SECRET = 'replace-with-a-long-random-session-secret';

function parseBoolean(value, defaultValue = false) {
    if (value === undefined || value === null || value === '') return defaultValue;
    return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function resolveSessionSecret(options = {}) {
    const secret = options.sessionSecret || process.env.SESSION_SECRET || DEFAULT_SESSION_SECRET;
    if (process.env.NODE_ENV === 'production'
        && (secret === DEFAULT_SESSION_SECRET || secret === PLACEHOLDER_SESSION_SECRET || secret.length < 32)) {
        throw new Error('SESSION_SECRET must be set to a non-placeholder value of at least 32 characters in production');
    }
    return secret;
}

function createDefaultSessionStore(pool) {
    const PgSession = connectPgSimple(session);
    return new PgSession({
        pool,
        tableName: 'session',
        createTableIfMissing: false
    });
}

function noStore(_req, res, next) {
    res.set('Cache-Control', 'no-store');
    return next();
}

function createStaticBoundary(root) {
    return (req, res, next) => {
        const normalized = path.normalize(req.path || '').replace(/^(\.\.[/\\])+/, '');
        const target = path.resolve(root, `.${normalized}`);
        if (!target.startsWith(root)) {
            return res.status(404).type('text/plain').send('Not found');
        }
        return next();
    };
}

// 登录墙放行的公开路径（登录页本身、健康检查、静态登录页资源）
const PUBLIC_PATHS = new Set(['/login', '/logout', '/favicon.ico', '/api/health', '/templates/login.html']);

// 静态资源放行：题库/脚本/样式/音频本身不含账号数据，放行可避免会话过期时页面脚本 302 变白屏
const PUBLIC_ASSET_EXTENSIONS = /\.(?:css|js|mjs|map|png|jpe?g|gif|svg|webp|avif|ico|woff2?|ttf|otf|eot|mp3|m4a|ogg|wav|json|txt|csv|md)$/i;

function isPublicAsset(req) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return false;
    return PUBLIC_ASSET_EXTENSIONS.test(req.path);
}

function createLoginGate() {
    return (req, res, next) => {
        if (req.session && req.session.user) return next();
        if (req.path.startsWith('/api/auth/')) return next();
        if (PUBLIC_PATHS.has(req.path)) return next();
        if (isPublicAsset(req)) return next();
        if (req.path.startsWith('/api/')) {
            return res.status(401).json({ error: 'Authentication required' });
        }
        if (req.accepts('html')) return res.redirect('/login');
        return res.status(401).type('text/plain').send('Authentication required');
    };
}

function createApp(options = {}) {
    const app = express();
    const repoRoot = options.repoRoot || path.resolve(__dirname, '..', '..');
    const dbClient = options.db || db;
    const cookieName = options.cookieName || 'ielts.sid';
    const cookieSecure = options.cookieSecure !== undefined
        ? Boolean(options.cookieSecure)
        : parseBoolean(process.env.COOKIE_SECURE, false);
    const trustProxy = options.trustProxy !== undefined
        ? options.trustProxy
        : parseBoolean(process.env.TRUST_PROXY, false);

    if (trustProxy) {
        app.set('trust proxy', process.env.TRUSTED_PROXY_IPS || true);
    }
    app.disable('x-powered-by');
    app.use(helmet({
        contentSecurityPolicy: false,
        crossOriginEmbedderPolicy: false
    }));
    app.use(express.json({ limit: options.jsonLimit || '1mb' }));
    app.use(express.urlencoded({ extended: false, limit: options.urlencodedLimit || '100kb' }));
    app.use(session({
        name: cookieName,
        secret: resolveSessionSecret(options),
        resave: false,
        saveUninitialized: false,
        store: options.sessionStore || (
            dbClient && dbClient.pool ? createDefaultSessionStore(dbClient.pool) : undefined
        ),
        cookie: {
            httpOnly: true,
            sameSite: 'lax',
            secure: cookieSecure,
            maxAge: options.sessionMaxAgeMs || 30 * 24 * 60 * 60 * 1000
        }
    }));

    const authStore = options.authStore || new PostgresAuthStore(dbClient);
    const practiceStore = options.practiceStore || new PostgresPracticeRecordStore(dbClient);

    app.get('/api/health', (_req, res) => {
        res.json({ ok: true });
    });

    app.use('/api/auth', noStore, createAuthRouter({
        store: authStore,
        registrationMode: options.registrationMode,
        cookieName,
        clearCookieOptions: {
            httpOnly: true,
            sameSite: 'lax',
            secure: cookieSecure
        }
    }));

    // ---- 未登录不得访问任何页面与静态资源 ----
    app.use(createLoginGate());

    app.get('/login', (_req, res) => {
        res.sendFile(path.join(repoRoot, 'templates', 'login.html'));
    });

    app.get('/logout', (req, res) => {
        const done = () => {
            res.clearCookie(cookieName, { httpOnly: true, sameSite: 'lax', secure: cookieSecure });
            res.redirect('/login');
        };
        if (req.session) return req.session.destroy(done);
        return done();
    });
    // ---- 登录墙结束 ----

    app.use('/api/practice-records', noStore, createPracticeRecordsRouter({
        store: practiceStore
    }));

    const staticOptions = {
        fallthrough: true,
        index: false,
        maxAge: options.staticMaxAge || '1h'
    };
    for (const dir of ['css', 'js', 'assets', 'templates']) {
        const root = path.join(repoRoot, dir);
        app.use(`/${dir}`, createStaticBoundary(root), express.static(root, staticOptions));
    }

    app.get(['/', '/index.html'], (_req, res) => {
        res.sendFile(path.join(repoRoot, 'index.html'));
    });

    app.use('/api', (_req, res) => {
        res.status(404).json({ error: 'Not found' });
    });

    app.use((error, _req, res, _next) => {
        const status = Number(error.status || error.statusCode || 500);
        if (status >= 500) {
            console.error(error);
        }
        res.status(status >= 400 && status < 600 ? status : 500).json({
            error: status >= 500 ? 'Internal server error' : error.message
        });
    });

    return app;
}

module.exports = {
    createApp,
    createLoginGate,
    createDefaultSessionStore,
    parseBoolean,
    resolveSessionSecret
};
