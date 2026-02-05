# AIH OpenClaw Backup Tool

Backup and restore OpenClaw AI assistants.

## Quick Start

```bash
npm install
export DATABASE_URL="postgres://..."
node aih-backup.js backup
node aih-backup.js list
node aih-backup.js restore 1
```

## Commands

| Command | Description |
|---------|-------------|
| `backup [name]` | Create backup |
| `list` | List backups |
| `restore <id>` | Restore backup |
| `help` | Show help |

## Environment

- `DATABASE_URL` - Neon PostgreSQL connection string

## Deployment to Railway

1. Push to GitHub
2. Connect to Railway
3. Set DATABASE_URL env var
4. Deploy
