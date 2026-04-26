#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────
// Knowledge MCP Server
// stdio transport, 4 tools: search, ingest, list, remove
// ─────────────────────────────────────────────────────────────

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'

import { TfIdfIndex } from './tfidf.js'
import { indexPath, makeSourceId } from './indexer.js'
import { loadIndex, saveIndex } from './store.js'

let index: TfIdfIndex

const server = new Server(
  { name: 'ava-knowledge', version: '0.0.1' },
  { capabilities: { tools: {} } },
)

// ── List Tools ────────────────────────────────────────────────

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'knowledge_search',
      description:
        'Search the local knowledge base for text relevant to a query. ' +
        'Returns ranked text chunks from previously ingested files.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          query: {
            type: 'string',
            description: 'The search query (natural language or keywords)',
          },
          limit: {
            type: 'number',
            description: 'Maximum number of results to return (default: 5)',
          },
        },
        required: ['query'],
      },
    },
    {
      name: 'knowledge_ingest',
      description:
        'Add a file or directory to the knowledge base. ' +
        'Supports .md, .txt, .ts, .py, .json and 25+ other text formats. ' +
        'Directories are indexed recursively (node_modules etc. are skipped).',
      inputSchema: {
        type: 'object' as const,
        properties: {
          path: {
            type: 'string',
            description: 'Absolute path to a file or directory to index',
          },
        },
        required: ['path'],
      },
    },
    {
      name: 'knowledge_list',
      description:
        'List all sources currently in the knowledge base, ' +
        'with their paths and chunk counts.',
      inputSchema: {
        type: 'object' as const,
        properties: {},
      },
    },
    {
      name: 'knowledge_remove',
      description:
        'Remove a source from the knowledge base by its source ID. ' +
        'Use knowledge_list to find source IDs.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          sourceId: {
            type: 'string',
            description: 'The source ID to remove (from knowledge_list)',
          },
        },
        required: ['sourceId'],
      },
    },
  ],
}))

// ── Call Tool ──────────────────────────────────────────────────

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params

  switch (name) {
    case 'knowledge_search': {
      const query = String(args?.query ?? '')
      const limit = Number(args?.limit ?? 5)
      if (!query.trim()) {
        return { content: [{ type: 'text', text: 'Error: query is required' }], isError: true }
      }
      const results = index.search(query, limit)
      if (results.length === 0) {
        return {
          content: [{
            type: 'text',
            text: `No results found for "${query}". The knowledge base has ${index.size} chunks from ${index.sources().length} source(s).`,
          }],
        }
      }
      const formatted = results.map((r, i) =>
        `--- Result ${i + 1} (score: ${r.score.toFixed(3)}) ---\n` +
        `Source: ${r.chunk.sourcePath}\n` +
        `Offset: ${r.chunk.offset}\n\n` +
        r.chunk.text,
      ).join('\n\n')
      return { content: [{ type: 'text', text: formatted }] }
    }

    case 'knowledge_ingest': {
      const targetPath = String(args?.path ?? '')
      if (!targetPath.trim()) {
        return { content: [{ type: 'text', text: 'Error: path is required' }], isError: true }
      }
      try {
        const result = await indexPath(targetPath)
        // Remove existing source to avoid duplicates
        const sourceId = makeSourceId(targetPath)
        index.removeSource(sourceId)
        // Add new chunks
        for (const chunk of result.chunks) {
          index.add(chunk)
        }
        await saveIndex(index)
        return {
          content: [{
            type: 'text',
            text: `Ingested ${result.fileCount} file(s), ${result.chunks.length} chunk(s) from ${result.isDirectory ? 'directory' : 'file'}: ${targetPath}`,
          }],
        }
      } catch (err) {
        return {
          content: [{
            type: 'text',
            text: `Error ingesting "${targetPath}": ${err instanceof Error ? err.message : String(err)}`,
          }],
          isError: true,
        }
      }
    }

    case 'knowledge_list': {
      const sources = index.sources()
      if (sources.length === 0) {
        return {
          content: [{
            type: 'text',
            text: 'Knowledge base is empty. Use knowledge_ingest to add files or directories.',
          }],
        }
      }
      const totalChunks = sources.reduce((sum, s) => sum + s.chunkCount, 0)
      const lines = [
        `Knowledge base: ${sources.length} source(s), ${totalChunks} total chunk(s)`,
        '',
        ...sources.map(s =>
          `• ${s.sourceId} — ${s.sourcePath} (${s.chunkCount} chunks)`,
        ),
      ]
      return { content: [{ type: 'text', text: lines.join('\n') }] }
    }

    case 'knowledge_remove': {
      const sourceId = String(args?.sourceId ?? '')
      if (!sourceId.trim()) {
        return { content: [{ type: 'text', text: 'Error: sourceId is required' }], isError: true }
      }
      const removed = index.removeSource(sourceId)
      if (removed === 0) {
        return {
          content: [{
            type: 'text',
            text: `No source found with ID "${sourceId}". Use knowledge_list to see available sources.`,
          }],
          isError: true,
        }
      }
      await saveIndex(index)
      return {
        content: [{
          type: 'text',
          text: `Removed ${removed} chunk(s) for source ${sourceId}.`,
        }],
      }
    }

    default:
      return {
        content: [{ type: 'text', text: `Unknown tool: ${name}` }],
        isError: true,
      }
  }
})

// ── Main ──────────────────────────────────────────────────────

async function main(): Promise<void> {
  index = await loadIndex()
  console.error(`[knowledge] loaded index: ${index.size} chunks, ${index.sources().length} sources`)

  const transport = new StdioServerTransport()
  await server.connect(transport)
  console.error('[knowledge] MCP server running on stdio')
}

main().catch(err => {
  console.error('[knowledge] fatal:', err)
  process.exit(1)
})
