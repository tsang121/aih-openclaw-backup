#!/usr/bin/env node

/**
 * AIH OpenClaw Backup Tool
 * CLI + Web Interface
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const { Client } = require('pg');
const readline = require('readline');

// Config
const WORKSPACE_DIR = '/Users/minimad/.openclaw/workspace';
const MEMORY_DIR = '/Users/minimad/.openclaw/workspace/memory';
const CONFIG_DIR = process.env.HOME + '/.openclaw';
const PORT = process.env.PORT || 3000;

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
    meta: { name: name || 'Manual Backup' }
  };
  
  // Backup workspace
  console.log('  • Workspace files...');
  backupData.workspace = getDirectoryTree(WORKSPACE_DIR);
  
  // Backup memory
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
  
  // Save to database
  const result = await client.query(
    'INSERT INTO aih_backups (name, data, workspace_hash, memory_hash) VALUES ($1, $2, $3, $4) RETURNING id',
    [name || 'Manual Backup', JSON.stringify(backupData), workspaceHash, memoryHash]
  );
  
  console.log(green(`\n✓ Backup saved! ID: ${result.rows[0].id}`));
  return result.rows[0].id;
}

async function restore(backupId) {
  console.log(blue('\n🔄 Restoring backup...'));
  
  const result = await client.query('SELECT * FROM aih_backups WHERE id = $1', [backupId]);
  if (result.rows.length === 0) {
    console.log(red('✗ Backup not found'));
    return false;
  }
  
  const data = result.rows[0].data;
  console.log(`  Restoring: ${data.meta.name}`);
  
  // Restore memory
  if (data.memory && data.memory.length > 0) {
    console.log('  • Memory files...');
    if (!fs.existsSync(MEMORY_DIR)) fs.mkdirSync(MEMORY_DIR, { recursive: true });
    data.memory.forEach(f => fs.writeFileSync(path.join(MEMORY_DIR, f.name), f.content));
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
  return true;
}

async function getBackups() {
  const result = await client.query('SELECT id, name, created_at FROM aih_backups ORDER BY created_at DESC LIMIT 50');
  return result.rows;
}

// HTTP Server
function startServer() {
  const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json');
    
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const pathname = url.pathname;
    
    if (pathname === '/api/status' && req.method === 'GET') {
      const backups = await getBackups();
      res.end(JSON.stringify({ status: 'ok', backups }));
      return;
    }
    
    if (pathname === '/api/backup' && req.method === 'POST') {
      try {
        const id = await backup('Web Backup');
        res.end(JSON.stringify({ success: true, id }));
      } catch (e) {
        res.writeHead(500);
        res.end(JSON.stringify({ success: false, error: e.message }));
      }
      return;
    }
    
    if (pathname.startsWith('/api/restore/') && req.method === 'POST') {
      const id = parseInt(pathname.split('/').pop());
      try {
        const success = await restore(id);
        res.end(JSON.stringify({ success }));
      } catch (e) {
        res.writeHead(500);
        res.end(JSON.stringify({ success: false, error: e.message }));
      }
      return;
    }
    
    // Dashboard HTML
    if (pathname === '/') {
      const backups = await getBackups();
      const html = generateDashboard(backups);
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(html);
      return;
    }
    
    res.writeHead(404);
    res.end('Not Found');
  });
  
  server.listen(PORT, '0.0.0.0', () => {
    console.log(green(`\n🌐 Web Interface: http://0.0.0.0:${PORT}`));
    console.log(`   API: http://0.0.0.0:${PORT}/api/status`);
  });
}

function generateDashboard(backups) {
  const list = backups.map(b => `
    <tr><td>${b.id}</td><td>${b.name}</td><td>${new Date(b.created_at).toLocaleString()}</td>
    <td><button onclick="restore(${b.id})">Restore</button></td></tr>
  `).join('');
  
  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>🤖 AIH Backup</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,sans-serif;background:linear-gradient(135deg,#1a1a2e,#16213e);min-height:100vh;color:#e2e8f0;padding:20px}
.container{max-width:800px;margin:0 auto}
h1{text-align:center;margin:30px 0;font-size:2rem}
.card{background:rgba(255,255,255,0.05);border-radius:16px;padding:24px;margin:20px 0;border:1px solid rgba(255,255,255,0.1)}
button{padding:12px 24px;border-radius:8px;border:none;font-size:1rem;cursor:pointer;background:#22c55e;color:white}
button:hover{opacity:0.9}
table{width:100%;border-collapse:collapse;margin-top:20px}
th,td{padding:12px;text-align:left;border-bottom:1px solid rgba(255,255,255,0.1)}
th{color:#94a3b8}
</style></head><body><div class="container">
<h1>🤖 AIH OpenClaw Backup</h1>
<div class="card"><h2>📦 Create Backup</h2>
<p style="color:#94a3b8;margin:10px 0">Backs up workspace, memory, and config</p>
<button onclick="createBackup()">Create New Backup</button>
</div>
<div class="card"><h2>💾 Available Backups</h2>
<table><thead><tr><th>ID</th><th>Name</th><th>Created</th><th>Action</th></tr></thead>
<tbody>${list || '<tr><td colspan="4">No backups yet</td></tr>'}</tbody></table>
</div></div>
<script>
async function createBackup(){const btn=document.querySelector('button');btn.textContent='Creating...';btn.disabled=true;
try{const r=await fetch('/api/backup',{method:'POST'});const d=await r.json();
if(d.success){alert('Backup created! ID: '+d.id);location.reload();}
else{alert('Error: '+d.error);}}
catch(e){alert('Error: '+e.message);}
btn.textContent='Create New Backup';btn.disabled=false;}
async function restore(id){if(!confirm('Restore backup #'+id+'?'))return;
try{const r=await fetch('/api/restore/'+id,{method:'POST'});const d=await r.json();
alert(d.success?'Restore complete!':'Error: '+d.error);}
catch(e){alert('Error: '+e.message);}}
</script></body></html>`;
}

function getDirectoryTree(dir, base = '') {
  const items = {};
  const files = fs.readdirSync(dir);
  files.forEach(f => {
    const fullPath = path.join(dir, f);
    if (fs.statSync(fullPath).isDirectory()) {
      items[f] = getDirectoryTree(fullPath, path.join(base, f));
    } else if (!f.endsWith('.DS_Store')) {
      const stats = fs.statSync(fullPath);
      if (stats.size > 1024 * 1024) return;
      items[f] = '[FILE_CONTENT]';
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
    } else if (content !== '[FILE_CONTENT]') {
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

async function list() {
  const result = await client.query('SELECT id, name, created_at FROM aih_backups ORDER BY created_at DESC LIMIT 20');
  console.log(blue('\n📋 Recent Backups:'));
  result.rows.forEach(row => {
    console.log(`  ${row.id}. ${row.name} - ${new Date(row.created_at).toLocaleString()}`);
  });
}

function showHelp() {
  console.log(`
🤖 AIH OpenClaw Backup Tool

Usage: node aih-backup.js <command>

Commands:
  backup [name]     Create a backup
  list              List backups
  restore <id>      Restore backup
  serve             Start web interface (default)
  help              Show this help

Environment:
  DATABASE_URL      Neon PostgreSQL connection string
`);
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0] || 'serve';
  
  if (!(await connect())) {
    console.log('\n📝 Set DATABASE_URL env var');
    process.exit(1);
  }
  
  await createTables();
  
  switch (command) {
    case 'backup':
      await backup(args[1] || 'Manual Backup');
      break;
    case 'list':
      await list();
      break;
    case 'restore':
      await restore(parseInt(args[1]));
      break;
    case 'serve':
      console.log(blue('\n🌐 Starting web interface...'));
      startServer();
      return new Promise(() => {});
    case 'help':
    default:
      showHelp();
      break;
  }
  
  await client.end();
}

main().catch(console.error);
