/**
 * prjct MCP Server — stdio entry point
 *
 * Usage: node dist/mcp/server.mjs
 *
 * Reads project ID from PRJCT_PROJECT_ID env var or auto-detects from cwd.
 */
import { serveStdio } from '@modelcontextprotocol/server/stdio'
import { createServer } from './server'

const handle = serveStdio(createServer)
const shutdown = () => void handle.close()

process.once('SIGINT', shutdown)
process.once('SIGTERM', shutdown)
