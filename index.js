import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { createClient } from '@supabase/supabase-js'
import { z } from 'zod'

// Fetch an image URL and return as base64 + mimeType
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

const supabase = createClient(
  'https://rpnnhwqfhexdadnxdnff.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJwbm5od3FmaGV4ZGFkbnhkbmZmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzgyNTY2MjQsImV4cCI6MjA5MzgzMjYyNH0.IHQsEYmgFn4voI8yIC8Jl57SJ-nM0rB1TrqBlSAV4xU'
)

const server = new McpServer({
  name: 'slice',
  version: '1.0.0',
})

// ── Tool 1: list_apps ─────────────────────────────────────────────
server.tool(
  'list_apps',
  'List all apps in the Slice library. Optionally filter by platform (iOS, Web) or category.',
  {
    platform: z.enum(['iOS', 'Web']).optional().describe('Filter by platform'),
    category: z.string().optional().describe('Filter by app category e.g. Finance, Health'),
  },
  async ({ platform, category }) => {
    let query = supabase.from('apps').select('id, name, description, platform, category, badge, icon_url').order('name')
    if (platform) query = query.eq('platform', platform)
    if (category) query = query.ilike('category', `%${category}%`)

    const { data, error } = await query
    if (error) return { content: [{ type: 'text', text: `Error: ${error.message}` }] }

    const text = data.map(a =>
      `• ${a.name} (${a.id}) — ${a.platform} · ${a.category}${a.badge ? ` [${a.badge}]` : ''}${a.description ? `\n  ${a.description}` : ''}`
    ).join('\n')

    return {
      content: [{
        type: 'text',
        text: `Found ${data.length} apps:\n\n${text}`,
      }]
    }
  }
)

// ── Tool 2: search_screens ────────────────────────────────────────
server.tool(
  'search_screens',
  'Search for screens in the Slice library by app, category (main flow), subflow, or version. Returns screens with their image URLs so you can view them.',
  {
    app_id:   z.string().optional().describe('App ID slug e.g. "disney", "spotify"'),
    category: z.string().optional().describe('Main flow / category e.g. "Onboarding", "Authentication"'),
    flow:     z.string().optional().describe('Subflow name e.g. "Sign up", "Log in"'),
    version:  z.string().optional().describe('Version label e.g. "May 2026"'),
    limit:    z.number().min(1).max(50).default(12).describe('Max number of screens to return (default 12)'),
  },
  async ({ app_id, category, flow, version, limit }) => {
    let query = supabase
      .from('screens')
      .select('id, image_url, category, flow_name, version, app_id, apps(name, platform, icon_url)')
      .limit(limit)

    if (app_id)   query = query.eq('app_id', app_id)
    if (category) query = query.ilike('category', `%${category}%`)
    if (flow)     query = query.ilike('flow_name', `%${flow}%`)
    if (version)  query = query.eq('version', version)

    const { data, error } = await query
    if (error) return { content: [{ type: 'text', text: `Error: ${error.message}` }] }
    if (!data.length) return { content: [{ type: 'text', text: 'No screens found matching your criteria.' }] }

    // Return both text summary and inline images
    const content = []

    content.push({
      type: 'text',
      text: `Found ${data.length} screens. Viewing them now to inspire your design:\n`,
    })

    for (const s of data) {
      content.push({
        type: 'text',
        text: `\n**${s.apps?.name || s.app_id}** — ${s.category || ''}${s.flow_name ? ` › ${s.flow_name}` : ''}${s.version ? ` (${s.version})` : ''}`,
      })
      const img = await imageToBase64(s.image_url)
      if (img) content.push({ type: 'image', data: img.data, mimeType: img.mimeType })
    }

    return { content }
  }
)

// ── Tool 3: get_app_screens ───────────────────────────────────────
server.tool(
  'get_app_screens',
  'Get all screens for a specific app, organised by flow. Use this to do a deep dive on a single app before designing.',
  {
    app_id:  z.string().describe('App ID slug e.g. "disney", "spotify"'),
    version: z.string().optional().describe('Filter to a specific version'),
  },
  async ({ app_id, version }) => {
    let query = supabase
      .from('screens')
      .select('id, image_url, category, flow_name, version, apps(name, platform)')
      .eq('app_id', app_id)
      .order('category')
      .order('flow_name')

    if (version) query = query.eq('version', version)

    const { data, error } = await query
    if (error) return { content: [{ type: 'text', text: `Error: ${error.message}` }] }
    if (!data.length) return { content: [{ type: 'text', text: `No screens found for app "${app_id}".` }] }

    const appName = data[0].apps?.name || app_id

    // Group by category
    const grouped = data.reduce((acc, s) => {
      const key = `${s.category || 'Other'} › ${s.flow_name || 'General'}`
      ;(acc[key] = acc[key] || []).push(s)
      return acc
    }, {})

    const content = [{
      type: 'text',
      text: `**${appName}** — ${data.length} screens across ${Object.keys(grouped).length} flows:\n`,
    }]

    for (const [flowLabel, screens] of Object.entries(grouped)) {
      content.push({ type: 'text', text: `\n### ${flowLabel} (${screens.length} screens)` })
      for (const s of screens) {
        const img = await imageToBase64(s.image_url)
        if (img) content.push({ type: 'image', data: img.data, mimeType: img.mimeType })
      }
    }

    return { content }
  }
)

// ── Start ─────────────────────────────────────────────────────────
const transport = new StdioServerTransport()
await server.connect(transport)
