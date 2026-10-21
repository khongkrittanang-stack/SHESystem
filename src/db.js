import sql from 'mssql';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load .env from azure-sql-api directory or parent
const localEnvPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(localEnvPath)) {
  dotenv.config({ path: localEnvPath });
} else {
  dotenv.config();
}

/**
 * Build SQL Connection Configuration
 * Supports full AZURE_SQL_CONNECTION_STRING or individual environment variables
 */
function getDbConfig() {
  const connString = process.env.AZURE_SQL_CONNECTION_STRING;
  if (connString && connString.trim()) {
    return connString.trim();
  }

  return {
    user: process.env.AZURE_SQL_USER || 'cloudadmin',
    password: process.env.AZURE_SQL_PASSWORD || '',
    server: process.env.AZURE_SQL_SERVER || 'halls.database.windows.net',
    database: process.env.AZURE_SQL_DATABASE || 'shedatabase',
    port: parseInt(process.env.AZURE_SQL_PORT || '1433', 10),
    options: {
      encrypt: process.env.AZURE_SQL_ENCRYPT !== 'false', // Default true for Azure SQL
      trustServerCertificate: process.env.AZURE_SQL_TRUST_CERT === 'true'
    },
    pool: {
      max: parseInt(process.env.AZURE_SQL_POOL_MAX || '10', 10),
      min: parseInt(process.env.AZURE_SQL_POOL_MIN || '0', 10),
      idleTimeoutMillis: 15000 // Release idle connections quickly to allow Serverless Auto-Pause
    },
    // Increased to 60s to accommodate Azure SQL Serverless cold-start wakeup time (~30-50s)
    connectionTimeout: parseInt(process.env.AZURE_SQL_CONNECTION_TIMEOUT || '60000', 10),
    requestTimeout: parseInt(process.env.AZURE_SQL_REQUEST_TIMEOUT || '60000', 10)
  };
}

let poolPromise = null;

export async function getPool() {
  if (!poolPromise) {
    const config = getDbConfig();
    const pool = new sql.ConnectionPool(config);

    // Listen for pool connection errors (e.g. when Azure SQL auto-pauses and disconnects)
    pool.on('error', (err) => {
      console.warn('⚠️ Azure SQL Connection Pool notice:', err.message);
      poolPromise = null;
    });

    poolPromise = pool
      .connect()
      .then((connectedPool) => {
        console.log('✅ เชื่อมต่อ Azure SQL Database สำเร็จ!');
        return connectedPool;
      })
      .catch((err) => {
        console.error('❌ เกิดข้อผิดพลาดในการเชื่อมต่อ Azure SQL Database:', err.message);
        poolPromise = null;
        throw err;
      });
  }
  return poolPromise;
}

/**
 * Execute parameterized query with automatic single retry for transient / cold-start resume
 * @param {string} queryText - T-SQL query string using @param placeholders
 * @param {Object} [params] - Key-value pair of parameters
 */
export async function query(queryText, params = {}) {
  const executeQuery = async () => {
    const pool = await getPool();
    const request = pool.request();

    for (const [key, val] of Object.entries(params)) {
      if (val === undefined || val === null) {
        request.input(key, sql.NVarChar, null);
      } else if (typeof val === 'number') {
        if (Number.isInteger(val)) {
          request.input(key, sql.Int, val);
        } else {
          request.input(key, sql.Float, val);
        }
      } else if (typeof val === 'boolean') {
        request.input(key, sql.Bit, val ? 1 : 0);
      } else {
        request.input(key, sql.NVarChar, String(val));
      }
    }

    return await request.query(queryText);
  };

  try {
    return await executeQuery();
  } catch (err) {
    const msg = (err.message || '').toLowerCase();
    const isTransient =
      msg.includes('closed') ||
      msg.includes('timeout') ||
      msg.includes('connection') ||
      msg.includes('failed to connect') ||
      err.code === 'ECONNRESET' ||
      err.code === 'ETIMEOUT';

    if (isTransient) {
      console.warn('⚠️ เกิดข้อผิดพลาดชั่วคราวในการเชื่อมต่อ DB (อาจกำลังตื่นจาก Auto-pause):', err.message);
      console.log('🔄 กำลังรอ 3 วินาทีและพยายามเชื่อมต่อใหม่...');
      poolPromise = null;
      await new Promise((res) => setTimeout(res, 3000));
      return await executeQuery();
    }
    throw err;
  }
}

/**
 * Execute raw batch commands (e.g. schema creation)
 */
export async function batch(batchText) {
  const pool = await getPool();
  return await pool.request().batch(batchText);
}

/**
 * Ensure database schema and default tables exist
 */
export async function initSchema() {
  try {
    const schemaPath = path.join(__dirname, 'schema.sql');
    if (fs.existsSync(schemaPath)) {
      const sqlContent = fs.readFileSync(schemaPath, 'utf-8');
      console.log('🔄 กำลังตรวจสอบและตั้งค่าตารางใน Azure SQL Database...');
      await batch(sqlContent);
      console.log('✅ ตารางใน Azure SQL Database พร้อมใช้งาน');
    }
  } catch (err) {
    console.error('⚠️ การสร้าง Schema อัตโนมัติล้มเหลว (หากสร้างไว้แล้วสามารถละเว้นได้):', err.message);
  }
}

export { sql };
