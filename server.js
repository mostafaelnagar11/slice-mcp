import express from 'express'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { createClient } from '@supabase/supabase-js'
import { z } from 'zod'

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://rpnnhwqfhexdadnxdnff.supabase.co'
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJwbm5od3FmaGV4ZGFkbnhkbmZmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzgyNTY2MjQsImV4cCI6MjA5MzgzMjYyNH0.IHQsEYmgFn4voI8yIC8Jl57SJ-nM0rB1TrqBlSAV4xU'
const PORT = process.env.PORT || 3000

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)

// Fetch image URL → base64
async function imageToBase64(url) {
  try {
    const res = await fetch(url)
    const buffer = await res.arrayBuffer()
    const mime = res.headers.get('content-type') || 'image/jpeg'
    return { data: Buffer.from(buffer).toString('base64'), mimeType: mime }
  } catch {
    return null
  }
}

// ── Build MCP server (reusable factory) ──────────────────────────
function buildServer() {
  const server = new McpServer({ name: 'slice', version: '1.0.0' })

  // Tool 1 — list_apps
  server.tool(
    'list_apps',
    'List all apps in the Slice library. Filter by platform (iOS, Web) or category.',
    {
      platform: z.enum(['iOS', 'Web']).optional(),
      category: z.string().optional(),
    },
    async ({ platform, category }) => {
      let query = supabase.from('apps').select('id, name, description, platform, category, badge').order('name')
      if (platform) query = query.eq('platform', platform)
      if (category) query = query.ilike('category', `%${category}%`)
      const { data, error } = await query
      if (error) return { content: [{ type: 'text', text: `Error: ${error.message}` }] }
      const text = data.map(a =>
        `• ${a.name} (${a.id}) — ${a.platform} · ${a.category}${a.badge ? ` [${a.badge}]` : ''}${a.description ? `\n  ${a.description}` : ''}`
      ).join('\n')
      return { content: [{ type: 'text', text: `Found ${data.length} apps:\n\n${text}` }] }
    }
  )

  // Tool 2 — search_screens
  server.tool(
    'search_screens',
    'Search screens by app, category (main flow), subflow, or version. Returns images for design inspiration.',
    {
      app_id:   z.string().optional().describe('App ID e.g. "disney"'),
      category: z.string().optional().describe('Main flow e.g. "Onboarding"'),
      flow:     z.string().optional().describe('Subflow e.g. "Sign up"'),
      version:  z.string().optional().describe('Version e.g. "May 2026"'),
      limit:    z.number().min(1).max(20).default(8),
    },
    async ({ app_id, category, flow, version, limit }) => {
      let query = supabase
        .from('screens')
        .select('id, image_url, category, flow_name, version, app_id, apps(name, platform)')
        .limit(limit)
      if (app_id)   query = query.eq('app_id', app_id)
      if (category) query = query.ilike('category', `%${category}%`)
      if (flow)     query = query.ilike('flow_name', `%${flow}%`)
      if (version)  query = query.eq('version', version)

      const { data, error } = await query
      if (error) return { content: [{ type: 'text', text: `Error: ${error.message}` }] }
      if (!data.length) return { content: [{ type: 'text', text: 'No screens found.' }] }

      const content = [{ type: 'text', text: `Found ${data.length} screens:\n` }]
      for (const s of data) {
        content.push({ type: 'text', text: `**${s.apps?.name || s.app_id}** — ${s.category || ''}${s.flow_name ? ` › ${s.flow_name}` : ''}${s.version ? ` (${s.version})` : ''}` })
        const img = await imageToBase64(s.image_url)
        if (img) content.push({ type: 'image', data: img.data, mimeType: img.mimeType })
      }
      return { content }
    }
  )

  // Tool 3 — get_app_screens
  server.tool(
    'get_app_screens',
    'Get all screens for a specific app grouped by flow.',
    {
      app_id:  z.string().describe('App ID e.g. "disney"'),
      version: z.string().optional(),
    },
    async ({ app_id, version }) => {
      let query = supabase
        .from('screens')
        .select('id, image_url, category, flow_name, version, apps(name)')
        .eq('app_id', app_id).order('category').order('flow_name')
      if (version) query = query.eq('version', version)

      const { data, error } = await query
      if (error) return { content: [{ type: 'text', text: `Error: ${error.message}` }] }
      if (!data.length) return { content: [{ type: 'text', text: `No screens found for "${app_id}".` }] }

      const grouped = data.reduce((acc, s) => {
        const key = `${s.category || 'Other'} › ${s.flow_name || 'General'}`
        ;(acc[key] = acc[key] || []).push(s)
        return acc
      }, {})

      const content = [{ type: 'text', text: `**${data[0].apps?.name || app_id}** — ${data.length} screens\n` }]
      for (const [label, screens] of Object.entries(grouped)) {
        content.push({ type: 'text', text: `\n### ${label}` })
        for (const s of screens) {
          const img = await imageToBase64(s.image_url)
          if (img) content.push({ type: 'image', data: img.data, mimeType: img.mimeType })
        }
      }
      return { content }
    }
  )

  return server
}

// ── Express HTTP server ───────────────────────────────────────────
const app = express()
app.use(express.json())
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, DELETE')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, mcp-session-id')
  if (req.method === 'OPTIONS') return res.sendStatus(200)
  next()
})

// Health check
app.get('/', (req, res) => res.json({ name: 'slice-mcp', status: 'ok', tools: ['list_apps', 'search_screens', 'get_app_screens'] }))

// MCP endpoint — one fresh server + transport per request (stateless)
app.post('/mcp', async (req, res) => {
  try {
    const server = buildServer()
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
    await server.connect(transport)
    await transport.handleRequest(req, res, req.body)
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ error: err.message })
  }
})

app.get('/mcp', async (req, res) => {
  try {
    const server = buildServer()
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
    await server.connect(transport)
    await transport.handleRequest(req, res)
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ error: err.message })
  }
})

app.delete('/mcp', async (req, res) => res.sendStatus(200))

app.listen(PORT, () => console.log(`Slice MCP running on port ${PORT}`))
