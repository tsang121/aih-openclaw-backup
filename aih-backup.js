#!/usr/bin/env node

/**
 * AIH OpenClaw Backup Tool
 * Backup and restore OpenClaw agents
 */

const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
const execSync = require('child_process').execSync;
const readline = require('readline');

// Config
const WORKSPACE_DIR = '/Users/minimad/.openclaw/workspace';
const MEMORY_DIR = '/Users/minimad/.openclaw/workspace/memory';
const CONFIG_DIR = process.env.HOME + '/.openclaw';

// Neon PostgreSQL connection
const client = new Client({
  connectionString: process.env.DATABASE_URL || 'postgres://user:pass@host:5432/neondb'
});

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

// Colors
const green = (text) => `\x1b[32m${text}\x1b[0m`;
const red = (text) => `\x1b[31m${text}\x1b[0m`;
const blue = (text) => `\x1b[34m${text}\x1b[0m`;

async function connect() {
  try {
    await client.connect();
    console.log(green('✓ Connected to Neon PostgreSQL'));
    return true;
  } catch (err) {
    console.log(red('✗ Connection failed:') + ' Set DATABASE_URL env var');
    return false;
  }
}

async function createTables() {
  await client.query(`
    CREATE TABLE IF NOT EXISTS aih_backups (
      id SERIAL PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      created_at TIMESTAMP DEFAULT NOW(),
      data JSONB NOT NULL,
      workspace_hash VARCHAR(64),
      memory_hash VARCHAR(64)
    )
  `);
  console.log(green('✓ Tables ready'));
}

async function backup(name) {
  console.log(blue('\n📦 Backing up OpenClaw...'));
  
  const backupData = {
    timestamp: new Date().toISOString(),
    workspace: {},
    memory: [],
    config: {},
    meta: {
      name: name || 'Manual Backup'
    }
  };
  
  // Backup workspace files
  console.log('  • Workspace files...');
  backupData.workspace = getDirectoryTree(WORKSPACE_DIR);
  
  // Backup memory files
  console.log('  • Memory files...');
  if (fs.existsSync(MEMORY_DIR)) {
    backupData.memory = fs.readdirSync(MEMORY_DIR).map(f => ({
      name: f,
      content: fs.readFileSync(path.join(MEMORY_DIR, f), 'utf8')
    }));
  }
  
  // Backup config
  console.log('  • Config...');
  const configPath = path.join(CONFIG_DIR, 'config.json');
  if (fs.existsSync(configPath)) {
    backupData.config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  }
  
  // Calculate hashes
  const workspaceHash = hashString(JSON.stringify(backupData.workspace));
  const memoryHash = hashString(JSON.stringify(backupData.memory));
  backupData.workspace_hash = workspaceHash;
  backupData.memory_hash = memoryHash;
  
  // Save to database
  const result = await client.query(
    'INSERT INTO aih_backups (name, data, workspace_hash, memory_hash) VALUES ($1, $2, $3, $4) RETURNING id',
    [name || 'Manual Backup', JSON.stringify(backupData), workspaceHash, memoryHash]
  );
  
  console.log(green(`\n✓ Backup saved! ID: ${result.rows[0].id}`));
  console.log(`  Files: ${Object.keys(backupData.workspace).length} workspace, ${backupData.memory.length} memory`);
  
  return result.rows[0].id;
}

async function restore(backupId) {
  console.log(blue('\n🔄 Restoring backup...'));
  
  const result = await client.query('SELECT * FROM aih_backups WHERE id = $1', [backupId]);
  if (result.rows.length === 0) {
    console.log(red('✗ Backup not found'));
    return;
  }
  
  const backup = result.rows[0];
  const data = backup.data;
  
  console.log(`  Restoring: ${data.meta.name} (${backup.created_at})`);
  
  // Restore memory files
  console.log('  • Memory files...');
  if (data.memory && data.memory.length > 0) {
    if (!fs.existsSync(MEMORY_DIR)) fs.mkdirSync(MEMORY_DIR, { recursive: true });
    data.memory.forEach(f => {
      fs.writeFileSync(path.join(MEMORY_DIR, f.name), f.content);
    });
  }
  
  // Restore workspace
  console.log('  • Workspace files...');
  restoreDirectoryTree(WORKSPACE_DIR, data.workspace);
  
  // Restore config
  if (Object.keys(data.config).length > 0) {
    console.log('  • Config...');
    const configPath = path.join(CONFIG_DIR, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify(data.config, null, 2));
  }
  
  console.log(green('\n✓ Restore complete!'));
}

async function list() {
  const result = await client.query('SELECT id, name, created_at, workspace_hash, memory_hash FROM aih_backups ORDER BY created_at DESC LIMIT 20');
  console.log(blue('\n📋 Recent Backups:'));
  result.rows.forEach(row => {
    const date = new Date(row.created_at).toLocaleString();
    console.log(`  ${row.id}. ${row.name} - ${date}`);
  });
}

async function cleanup() {
  await client.end();
  rl.close();
}

// Helpers
function getDirectoryTree(dir, base = '') {
  const items = {};
  const files = fs.readdirSync(dir);
  
  files.forEach(f => {
    const fullPath = path.join(dir, f);
    const relPath = path.join(base, f);
    
    if (fs.statSync(fullPath).isDirectory()) {
      items[f] = getDirectoryTree(fullPath, relPath);
    } else if (!f.endsWith('.DS_Store')) {
      // Skip large files
      const stats = fs.statSync(fullPath);
      if (stats.size > 1024 * 1024) return; // Skip > 1MB
      items[f] = '[FILE_CONTENT_REMOVED_FOR_SIZE]';
    }
  });
  
  return items;
}

function restoreDirectoryTree(baseDir, tree) {
  Object.entries(tree).forEach(([name, content]) => {
    const fullPath = path.join(baseDir, name);
    
    if (typeof content === 'object') {
      if (!fs.existsSync(fullPath)) fs.mkdirSync(fullPath, { recursive: true });
      restoreDirectoryTree(fullPath, content);
    } else if (content !== '[FILE_CONTENT_REMOVED_FOR_SIZE]') {
      fs.writeFileSync(fullPath, content);
    }
  });
}

function hashString(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return Math.abs(hash).toString(16);
}

// Main
async function main() {
  const args = process.argv.slice(2);
  const command = args[0] || 'help';
  
  if (!(await connect())) {
    console.log('\n📝 Setup DATABASE_URL first:');
    console.log('  export DATABASE_URL="postgres://user:pass@ep-xxx.ap-southeast-1.aws.neon.tech/neondb"');
    process.exit(1);
  }
  
  await createTables();
  
  switch (command) {
    case 'backup':
      await backup(args[1] || 'Manual Backup');
      break;
    case 'restore':
      const id = parseInt(args[1]) || await askBackupId();
      await restore(id);
      break;
    case 'list':
      await list();
      break;
    case 'help':
    default:
      showHelp();
      break;
  }
  
  await cleanup();
}

function showHelp() {
  console.log(`
\x1b[34m🤖 AIH OpenClaw Backup Tool\x1b[0m

Usage: node aih.js <command> [options]

Commands:
  backup [name]     Create a backup (default: "Manual Backup")
  restore <id>      Restore a backup by ID
  list              List recent backups
  help              Show this help

Examples:
  node aih.js backup "Before update"
  node aih.js list
  node aih.js restore 5

Environment:
  DATABASE_URL      Neon PostgreSQL connection string
`);
}

function askBackupId() {
  return new Promise(resolve => {
    rl.question('Enter backup ID: ', ans => resolve(parseInt(ans)));
  });
}

main().catch(console.error);
