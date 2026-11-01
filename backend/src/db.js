const path = require('node:path');
const dotenv = require('dotenv');
const { Pool } = require('pg');

dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

function createPool(options = {}) {
    const baseConfig = process.env.DATABASE_URL
        ? { connectionString: process.env.DATABASE_URL }
        : {};
    const pool = new Pool({
        ...baseConfig,
        ...options
    });
    // pg 连接池的空闲连接被服务端关闭时会 emit('error')；没有监听器会让 Node 进程整体崩溃
    // （数据库重启/云平台维护后必现）。这里接管错误，只让当前这一次查询失败。
    pool.on('error', (error) => {
        console.error('[db] idle client error:', error && (error.code || error.message));
    });
    return pool;
}

const pool = createPool();

async function withClient(handler) {
    const client = await pool.connect();
    try {
        return await handler(client);
    } finally {
        client.release();
    }
}

async function query(text, params) {
    return pool.query(text, params);
}

async function withTransaction(handler) {
    return withClient(async (client) => {
        await client.query('BEGIN');
        try {
            const result = await handler(client);
            await client.query('COMMIT');
            return result;
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        }
    });
}

module.exports = {
    createPool,
    pool,
    query,
    withClient,
    withTransaction
};
