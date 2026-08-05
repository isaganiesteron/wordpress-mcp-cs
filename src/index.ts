/**
 * ============================================================================
 * CUSTOMIZATION SECTION - Update these values for your MCP server
 * ============================================================================
 */
const CONFIG = {
	serverName: 'wordpress-mcp-server',
	serverVersion: '1.0.0',
	serverDescription: 'Contractor Scale WordPress MCP Server',
	protocolVersion: '2025-03-26',
	keepAliveInterval: 30000, // 30 seconds
	// API Key Authentication
	requireApiKey: true, // Set to false to disable API key requirement
	apiKeyHeader: 'X-API-Key' as 'X-API-Key' | 'Authorization', // Header name to check for API key (alternative: 'Authorization')
} as const;

const MCP_SESSION_HEADER = 'Mcp-Session-Id';

/**
 * ============================================================================
 * WORDPRESS / SUPABASE HELPERS
 * ============================================================================
 * Ported from contractor-scale/skills/wordpress/scripts/_wp.js and
 * contractor-scale/skills/lib/secrets.js (sbSelect). Same PostgREST call and
 * Basic-auth REST pattern, just reading from env (Worker secrets) instead of
 * process.env, and no local-JSON-file fallback (no filesystem in Workers).
 */

interface WpCredentialRow {
	client_slug: string;
	site_url: string;
	auth_type: string;
	username: string;
	token: string;
	seo_plugin: string | null;
	elementor: boolean | null;
}

async function resolveClient(slug: string, env: Env): Promise<WpCredentialRow> {
	const params = new URLSearchParams({
		select: 'client_slug,site_url,auth_type,username,token,seo_plugin,elementor',
	});
	params.set('client_slug', `eq.${slug}`);

	const res = await fetch(`${env.SUPABASE_URL}/rest/v1/wp_credentials?${params.toString()}`, {
		headers: {
			apikey: env.SUPABASE_SECRET_KEY,
			Authorization: `Bearer ${env.SUPABASE_SECRET_KEY}`,
			Accept: 'application/json',
		},
	});
	if (!res.ok) {
		throw new Error(`Supabase wp_credentials read failed: ${res.status} ${await res.text()}`);
	}
	const rows: WpCredentialRow[] = await res.json();
	if (!rows.length) {
		throw new Error(`No wp_credentials row for client_slug='${slug}'. Use wp_list_clients for valid slugs.`);
	}
	const row = rows[0];
	if (row.auth_type !== 'application_password') {
		throw new Error(`client '${slug}' has auth_type='${row.auth_type}'; this server only supports 'application_password'.`);
	}
	if (!row.token) {
		throw new Error(`client '${slug}' has no token stored. Provision one in WP: Users -> Profile -> Application Passwords.`);
	}
	return row;
}

function authHeader(row: WpCredentialRow): string {
	// WP displays application passwords with spaces for readability; strip them before auth.
	const token = row.token.replace(/\s+/g, '');
	return 'Basic ' + btoa(`${row.username}:${token}`);
}

interface WpFetchOptions {
	method?: string;
	body?: unknown;
	rawBody?: BodyInit;
	contentType?: string;
	extraHeaders?: Record<string, string>;
}

interface WpFetchResult {
	ok: boolean;
	status: number;
	data: unknown;
}

// Call the WP REST API. `path` may be absolute (http...) or a /namespace/route under /wp-json.
async function wpFetch(row: WpCredentialRow, path: string, opts: WpFetchOptions = {}): Promise<WpFetchResult> {
	const { method = 'GET', body, rawBody, contentType, extraHeaders } = opts;
	const base = row.site_url.replace(/\/+$/, '');
	const url = path.startsWith('http') ? path : `${base}/wp-json${path.startsWith('/') ? '' : '/'}${path}`;

	const res = await fetch(url, {
		method,
		headers: {
			Authorization: authHeader(row),
			'Content-Type': contentType || 'application/json',
			Accept: 'application/json',
			'User-Agent': 'CS-WordPress-MCP/1.0 (+https://contractorscale.com)',
			...extraHeaders,
		},
		body: rawBody ?? (body ? JSON.stringify(body) : undefined),
	});
	const text = await res.text();
	let data: unknown;
	try {
		data = text ? JSON.parse(text) : null;
	} catch {
		data = text;
	}
	return { ok: res.ok, status: res.status, data };
}

// Fetch an image from a URL and upload it to the site's media library. Returns the new media id.
async function uploadFeaturedImage(row: WpCredentialRow, imageUrl: string, filename?: string): Promise<number> {
	const imgRes = await fetch(imageUrl);
	if (!imgRes.ok) {
		throw new Error(`Could not fetch image_url (HTTP ${imgRes.status}): ${imageUrl}`);
	}
	const contentType = imgRes.headers.get('content-type') || 'application/octet-stream';
	const bytes = await imgRes.arrayBuffer();
	const resolvedName = filename || imageUrl.split('/').pop()?.split('?')[0] || 'upload.jpg';

	const uploadRes = await wpFetch(row, '/wp/v2/media', {
		method: 'POST',
		rawBody: bytes,
		contentType,
		extraHeaders: { 'Content-Disposition': `attachment; filename="${resolvedName}"` },
	});
	if (!uploadRes.ok) {
		throw new Error(`Media upload failed (HTTP ${uploadRes.status}): ${JSON.stringify(uploadRes.data)}`);
	}
	const mediaId = (uploadRes.data as { id?: number } | null)?.id;
	if (!mediaId) {
		throw new Error(`Media upload succeeded but no id in response: ${JSON.stringify(uploadRes.data)}`);
	}
	return mediaId;
}

function requireArg(args: Record<string, unknown>, name: string): string {
	const value = args[name];
	if (typeof value !== 'string' || !value) {
		throw new Error(`Missing required argument: ${name}`);
	}
	return value;
}

function textResult(payload: unknown): ToolResult {
	return { content: [{ type: 'text', text: typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2) }] };
}

/**
 * ============================================================================
 * TOOL DEFINITIONS
 * ============================================================================
 * Each tool should have:
 * - name: unique identifier for the tool
 * - description: what the tool does
 * - inputSchema: JSON schema defining the input parameters
 * - handler: function that executes the tool logic
 */

interface Tool {
	name: string;
	description: string;
	inputSchema: {
		type: string;
		properties: Record<string, { type: string; description: string }>;
		required: string[];
	};
	handler: (args: Record<string, unknown>, env?: Env) => Promise<ToolResult> | ToolResult;
}

interface ToolResult {
	content: Array<{
		type: string;
		text: string;
	}>;
}

const TOOLS: Tool[] = [
	{
		name: 'wp_list_clients',
		description: 'List every WordPress client configured in Supabase wp_credentials (site_url, seo_plugin, elementor). No secrets returned.',
		inputSchema: { type: 'object', properties: {}, required: [] },
		handler: async (_args, env) => {
			const params = new URLSearchParams({ select: 'client_slug,site_url,seo_plugin,elementor' });
			const res = await fetch(`${env!.SUPABASE_URL}/rest/v1/wp_credentials?${params.toString()}`, {
				headers: { apikey: env!.SUPABASE_SECRET_KEY, Authorization: `Bearer ${env!.SUPABASE_SECRET_KEY}`, Accept: 'application/json' },
			});
			if (!res.ok) throw new Error(`Supabase wp_credentials read failed: ${res.status} ${await res.text()}`);
			const rows = await res.json();
			return textResult(rows);
		},
	},
	{
		name: 'wp_list_posts',
		description: 'List/query posts on a client site by status, search term, or slug.',
		inputSchema: {
			type: 'object',
			properties: {
				client: { type: 'string', description: 'wp_credentials client_slug' },
				status: { type: 'string', description: 'publish | draft | pending | private | future (default: publish)' },
				search: { type: 'string', description: 'Free-text search term' },
				slug: { type: 'string', description: 'Exact post slug to look up' },
				per_page: { type: 'number', description: 'Results per page, max 100 (default 10)' },
				orderby: { type: 'string', description: 'date | title | slug (default: date)' },
			},
			required: ['client'],
		},
		handler: async (args, env) => {
			const row = await resolveClient(requireArg(args, 'client'), env!);
			const params = new URLSearchParams();
			if (args.status) params.set('status', String(args.status));
			if (args.search) params.set('search', String(args.search));
			if (args.slug) params.set('slug', String(args.slug));
			if (args.per_page) params.set('per_page', String(args.per_page));
			if (args.orderby) params.set('orderby', String(args.orderby));
			const result = await wpFetch(row, `/wp/v2/posts?${params.toString()}`);
			if (!result.ok) throw new Error(`List posts failed (HTTP ${result.status}): ${JSON.stringify(result.data)}`);
			return textResult(result.data);
		},
	},
	{
		name: 'wp_publish_post',
		description: 'Create a post on a client site. Use status "future" with a date to schedule; "draft" to create without publishing.',
		inputSchema: {
			type: 'object',
			properties: {
				client: { type: 'string', description: 'wp_credentials client_slug' },
				title: { type: 'string', description: 'Post title' },
				content: { type: 'string', description: 'Post content (HTML)' },
				status: { type: 'string', description: 'draft | publish | future (default: draft)' },
				date: { type: 'string', description: 'ISO 8601 date, required when status=future' },
				slug: { type: 'string', description: 'Optional custom slug' },
			},
			required: ['client', 'title', 'content'],
		},
		handler: async (args, env) => {
			const row = await resolveClient(requireArg(args, 'client'), env!);
			const status = (args.status as string) || 'draft';
			if (status === 'future' && !args.date) {
				throw new Error('status="future" requires a date (ISO 8601).');
			}
			const body: Record<string, unknown> = { title: args.title, content: args.content, status };
			if (args.date) body.date = args.date;
			if (args.slug) body.slug = args.slug;
			const result = await wpFetch(row, '/wp/v2/posts', { method: 'POST', body });
			if (!result.ok) throw new Error(`Publish post failed (HTTP ${result.status}): ${JSON.stringify(result.data)}`);
			return textResult(result.data);
		},
	},
	{
		name: 'wp_update_post',
		description: 'Update an existing post on a client site (content, status, slug, or scheduled date). Only provided fields are changed.',
		inputSchema: {
			type: 'object',
			properties: {
				client: { type: 'string', description: 'wp_credentials client_slug' },
				post_id: { type: 'number', description: 'WordPress post ID' },
				content: { type: 'string', description: 'New post content (HTML)' },
				status: { type: 'string', description: 'draft | publish | future | private' },
				slug: { type: 'string', description: 'New slug' },
				date: { type: 'string', description: 'ISO 8601 date (for rescheduling)' },
			},
			required: ['client', 'post_id'],
		},
		handler: async (args, env) => {
			const row = await resolveClient(requireArg(args, 'client'), env!);
			const postId = args.post_id;
			if (!postId) throw new Error('Missing required argument: post_id');
			const body: Record<string, unknown> = {};
			for (const key of ['content', 'status', 'slug', 'date']) {
				if (args[key] !== undefined) body[key] = args[key];
			}
			if (Object.keys(body).length === 0) throw new Error('Provide at least one field to update (content, status, slug, date).');
			const result = await wpFetch(row, `/wp/v2/posts/${postId}`, { method: 'POST', body });
			if (!result.ok) throw new Error(`Update post failed (HTTP ${result.status}): ${JSON.stringify(result.data)}`);
			return textResult(result.data);
		},
	},
	{
		name: 'wp_set_featured_image',
		description: "Upload an image from a URL to a client site's media library and set it as a post's featured image.",
		inputSchema: {
			type: 'object',
			properties: {
				client: { type: 'string', description: 'wp_credentials client_slug' },
				post_id: { type: 'number', description: 'WordPress post ID' },
				image_url: { type: 'string', description: 'Publicly reachable URL of the image to upload' },
				filename: { type: 'string', description: 'Optional filename to store the media as (default: derived from image_url)' },
			},
			required: ['client', 'post_id', 'image_url'],
		},
		handler: async (args, env) => {
			const row = await resolveClient(requireArg(args, 'client'), env!);
			const postId = args.post_id;
			if (!postId) throw new Error('Missing required argument: post_id');
			const mediaId = await uploadFeaturedImage(row, requireArg(args, 'image_url'), args.filename as string | undefined);
			const result = await wpFetch(row, `/wp/v2/posts/${postId}`, { method: 'POST', body: { featured_media: mediaId } });
			if (!result.ok) throw new Error(`Setting featured_media failed (HTTP ${result.status}): ${JSON.stringify(result.data)}`);
			return textResult({ media_id: mediaId, post: result.data });
		},
	},
	{
		name: 'wp_set_seo_meta',
		description: 'Set RankMath SEO meta (title, description, focus keyword) on a post. Requires RankMath with show_in_rest enabled for these meta keys on the target site.',
		inputSchema: {
			type: 'object',
			properties: {
				client: { type: 'string', description: 'wp_credentials client_slug' },
				post_id: { type: 'number', description: 'WordPress post ID' },
				title: { type: 'string', description: 'RankMath SEO title' },
				description: { type: 'string', description: 'RankMath meta description' },
				focus_keyword: { type: 'string', description: 'RankMath focus keyword' },
			},
			required: ['client', 'post_id'],
		},
		handler: async (args, env) => {
			const row = await resolveClient(requireArg(args, 'client'), env!);
			if (row.seo_plugin !== 'rankmath') {
				throw new Error(
					`client '${row.client_slug}' uses seo_plugin='${row.seo_plugin || 'unknown'}', not RankMath. ` +
						'This tool only writes rank_math_* meta keys and has no effect on Yoast or other SEO plugins.'
				);
			}
			const postId = args.post_id;
			if (!postId) throw new Error('Missing required argument: post_id');
			const meta: Record<string, unknown> = {};
			if (args.title !== undefined) meta.rank_math_title = args.title;
			if (args.description !== undefined) meta.rank_math_description = args.description;
			if (args.focus_keyword !== undefined) meta.rank_math_focus_keyword = args.focus_keyword;
			if (Object.keys(meta).length === 0) throw new Error('Provide at least one of: title, description, focus_keyword.');
			const result = await wpFetch(row, `/wp/v2/posts/${postId}`, { method: 'POST', body: { meta } });
			if (!result.ok) {
				throw new Error(
					`Set SEO meta failed (HTTP ${result.status}): ${JSON.stringify(result.data)}. ` +
						'If this site has never accepted these meta keys via REST before, RankMath may not have show_in_rest enabled for them.'
				);
			}
			return textResult(result.data);
		},
	},
	{
		name: 'wp_get_post',
		description: 'Get a single post by ID from a client site (e.g. to confirm a publish/update landed).',
		inputSchema: {
			type: 'object',
			properties: {
				client: { type: 'string', description: 'wp_credentials client_slug' },
				post_id: { type: 'number', description: 'WordPress post ID' },
			},
			required: ['client', 'post_id'],
		},
		handler: async (args, env) => {
			const row = await resolveClient(requireArg(args, 'client'), env!);
			const postId = args.post_id;
			if (!postId) throw new Error('Missing required argument: post_id');
			const result = await wpFetch(row, `/wp/v2/posts/${postId}`);
			if (!result.ok) throw new Error(`Get post failed (HTTP ${result.status}): ${JSON.stringify(result.data)}`);
			return textResult(result.data);
		},
	},
	{
		name: 'wp_raw_request',
		description:
			'Escape hatch: make an arbitrary authenticated WP REST call for a client (e.g. DELETE /wp-json/elementor/v1/cache, or a plugin-specific route not covered by the other tools). Use the other tools when they fit; this is for the long tail.',
		inputSchema: {
			type: 'object',
			properties: {
				client: { type: 'string', description: 'wp_credentials client_slug' },
				method: { type: 'string', description: 'HTTP method (GET, POST, PUT, DELETE, ...)' },
				path: { type: 'string', description: 'REST path under /wp-json, e.g. /wp/v2/posts or /elementor/v1/cache' },
				body: { type: 'string', description: 'Optional JSON-encoded request body' },
			},
			required: ['client', 'method', 'path'],
		},
		handler: async (args, env) => {
			const row = await resolveClient(requireArg(args, 'client'), env!);
			const method = requireArg(args, 'method').toUpperCase();
			const path = requireArg(args, 'path');
			console.warn(`wp_raw_request used: ${method} ${path} (client=${row.client_slug}) — consider a dedicated tool if this recurs`);
			let body: unknown;
			if (typeof args.body === 'string' && args.body.length > 0) {
				body = JSON.parse(args.body);
			}
			// TODO: throttle if this tool is ever used for bulk ops (sequential calls, no delay between them today).
			const result = await wpFetch(row, path, { method, body });
			return textResult(result);
		},
	},
];

/**
 * ============================================================================
 * FRAMEWORK CODE - You typically don't need to modify below this line
 * ============================================================================
 */

/**
 * ============================================================================
 * API KEY VALIDATION
 * ============================================================================
 */
function validateApiKey(request: Request, env: Env): { valid: boolean; error?: Response } {
	if (!CONFIG.requireApiKey) {
		return { valid: true };
	}

	const apiKey = env.API_KEY;
	if (!apiKey) {
		console.error('API_KEY environment variable is not set');
		return {
			valid: false,
			error: new Response(
				JSON.stringify({
					error: 'Server configuration error: API key not configured',
				}),
				{
					status: 500,
					headers: { 'Content-Type': 'application/json' },
				}
			),
		};
	}

	// Check for API key in header
	let providedKey: string | null = null;

	if (CONFIG.apiKeyHeader === 'Authorization') {
		const authHeader = request.headers.get('Authorization');
		if (authHeader && authHeader.startsWith('Bearer ')) {
			providedKey = authHeader.substring(7);
		} else if (authHeader) {
			providedKey = authHeader; // Allow just the key without Bearer prefix
		}
	} else {
		providedKey = request.headers.get(CONFIG.apiKeyHeader);
	}

	if (!providedKey) {
		return {
			valid: false,
			error: new Response(
				JSON.stringify({
					error: 'API key required',
					message: `Please provide an API key in the ${CONFIG.apiKeyHeader} header`,
				}),
				{
					status: 401,
					headers: { 'Content-Type': 'application/json' },
				}
			),
		};
	}

	if (providedKey !== apiKey) {
		return {
			valid: false,
			error: new Response(
				JSON.stringify({
					error: 'Invalid API key',
				}),
				{
					status: 401,
					headers: { 'Content-Type': 'application/json' },
				}
			),
		};
	}

	return { valid: true };
}

// Session interface for SSE connections
interface Session {
	writer: WritableStreamDefaultWriter<Uint8Array>;
	encoder: TextEncoder;
}

// Store active sessions
const sessions = new Map<string, Session>();

function isValidMcpSessionId(sessionId: string): boolean {
	return sessionId.length > 0 && sessionId.length <= 128;
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);

		// CORS headers - modify if you need to restrict origins
		const corsHeaders = {
			'Access-Control-Allow-Origin': '*', // Change to specific domain if needed
			'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
			'Access-Control-Allow-Headers': 'Content-Type, Accept, X-API-Key, Authorization, Mcp-Session-Id, MCP-Protocol-Version',
			'Access-Control-Expose-Headers': 'Mcp-Session-Id',
		};

		console.log(`${request.method} ${url.pathname}`);

		// Handle CORS preflight
		if (request.method === 'OPTIONS') {
			return new Response(null, { headers: corsHeaders });
		}

		// Health check endpoint (no API key required)
		if (url.pathname === '/' || url.pathname === '') {
			return new Response(
				JSON.stringify({
					name: CONFIG.serverDescription,
					version: CONFIG.serverVersion,
					status: 'running',
					endpoints: {
						sse: '/sse',
						mcp: '/mcp',
					},
				}),
				{
					headers: {
						'Content-Type': 'application/json',
						...corsHeaders,
					},
				}
			);
		}

		// Validate API key for all other endpoints (except health check)
		const apiKeyValidation = validateApiKey(request, env);
		if (!apiKeyValidation.valid) {
			const errorText = await apiKeyValidation.error!.text();
			return new Response(errorText, {
				status: apiKeyValidation.error!.status,
				headers: {
					'Content-Type': 'application/json',
					...corsHeaders,
				},
			});
		}

		// SSE endpoint - GET only
		if (url.pathname === '/sse' && request.method === 'GET') {
			const { readable, writable } = new TransformStream();
			const writer = writable.getWriter();
			const encoder = new TextEncoder();

			// Generate session ID
			const sessionId: string = crypto.randomUUID().replace(/-/g, '');

			// Store session
			sessions.set(sessionId, { writer, encoder });
			console.log('Created SSE session:', sessionId);

			// Send endpoint immediately
			(async () => {
				try {
					await writer.write(encoder.encode(`event: endpoint\ndata: /sse/message?sessionId=${sessionId}\n\n`));

					// Keep-alive ping
					const keepAlive = setInterval(async () => {
						try {
							await writer.write(encoder.encode(': ping\n\n'));
						} catch {
							clearInterval(keepAlive);
							sessions.delete(sessionId);
						}
					}, CONFIG.keepAliveInterval);
				} catch (error) {
					console.error('SSE error:', error);
					sessions.delete(sessionId);
				}
			})();

			return new Response(readable, {
				headers: {
					'Content-Type': 'text/event-stream',
					'Cache-Control': 'no-cache',
					Connection: 'keep-alive',
					...corsHeaders,
				},
			});
		}

		// Handle POST to /sse (some clients do this for direct HTTP)
		if (url.pathname === '/sse' && request.method === 'POST') {
			console.log('Received POST to /sse - redirecting to message handler');
			// Treat this as a direct message without session
			return handleMessage(request, corsHeaders, null, env);
		}

		// Messages endpoint with session
		if (url.pathname === '/sse/message' && request.method === 'POST') {
			const sessionId = url.searchParams.get('sessionId');
			console.log('Received POST to /sse/message with sessionId:', sessionId);

			const session = sessions.get(sessionId || '') ?? null;
			return handleMessage(request, corsHeaders, session, env);
		}

		// Streamable HTTP MCP endpoint
		if (url.pathname === '/mcp' && (request.method === 'POST' || request.method === 'DELETE')) {
			return handleMcpRequest(request, corsHeaders, env);
		}

		return new Response('Not Found', {
			status: 404,
			headers: corsHeaders,
		});
	},
};

// Centralized message handler (SSE entry point)
async function handleMessage(
	request: Request,
	corsHeaders: Record<string, string>,
	session: Session | null,
	env: Env,
	endpointLabel = 'unknown'
) {
	const body = await request.text();
	return handleMessageFromBody(body, corsHeaders, session, env, endpointLabel, null);
}

// Core MCP message dispatch logic
async function handleMessageFromBody(
	body: string,
	corsHeaders: Record<string, string>,
	session: Session | null,
	env: Env,
	endpointLabel: string,
	mcpSessionId: string | null
) {
	const responseHeaders: Record<string, string> = { ...corsHeaders };
	if (mcpSessionId) {
		responseHeaders[MCP_SESSION_HEADER] = mcpSessionId;
	}

	try {
		console.log('Received body:', body);

		let message;
		try {
			message = JSON.parse(body);
		} catch (parseError) {
			console.error('JSON parse error:', parseError);
			const errorResponse = {
				jsonrpc: '2.0',
				error: {
					code: -32700,
					message: 'Parse error',
				},
			};
			return new Response(JSON.stringify(errorResponse), {
				status: 400,
				headers: {
					'Content-Type': 'application/json',
					...responseHeaders,
				},
			});
		}

		console.log('Parsed message:', JSON.stringify(message));

		let response: Record<string, unknown> | null = null;

		// Handle initialize
		if (message.method === 'initialize') {
			response = {
				jsonrpc: '2.0',
				id: message.id,
				result: {
					protocolVersion: CONFIG.protocolVersion,
					capabilities: { tools: {} },
					serverInfo: {
						name: CONFIG.serverName,
						version: CONFIG.serverVersion,
					},
				},
			};
		}
		// Handle tools/list
		else if (message.method === 'tools/list') {
			response = {
				jsonrpc: '2.0',
				id: message.id,
				result: {
					tools: TOOLS.map((tool: Tool) => ({
						name: tool.name,
						description: tool.description,
						inputSchema: tool.inputSchema,
					})),
				},
			};
		}
		// Handle tools/call
		else if (message.method === 'tools/call') {
			const { name, arguments: args } = message.params;

			// Find the tool by name
			const tool = TOOLS.find((t: Tool) => t.name === name);

			if (tool) {
				try {
					const result = await tool.handler(args, env);
					response = {
						jsonrpc: '2.0',
						id: message.id,
						result,
					};
				} catch (toolError: unknown) {
					response = {
						jsonrpc: '2.0',
						id: message.id,
						error: {
							code: -32603,
							message: toolError instanceof Error ? toolError.message : 'Tool execution failed',
						},
					};
				}
			} else {
				response = {
					jsonrpc: '2.0',
					id: message.id,
					error: {
						code: -32601,
						message: `Unknown tool: ${name}`,
					},
				};
			}
		}
		// Handle notifications/initialized
		else if (message.method === 'notifications/initialized') {
			console.log('Received initialized notification');
			return new Response(null, {
				status: 204,
				headers: responseHeaders,
			});
		} else {
			response = {
				jsonrpc: '2.0',
				id: message.id || null,
				error: {
					code: -32601,
					message: `Method not found: ${message.method}`,
				},
			};
		}

		console.log('Sending response:', JSON.stringify(response));

		// If we have a session, send via SSE
		if (session && response) {
			try {
				await session.writer.write(session.encoder.encode(`data: ${JSON.stringify(response)}\n\n`));
			} catch (sseError) {
				console.error('SSE write error:', sseError);
			}
		}

		// Always return response directly for HTTP
		if (response) {
			return new Response(JSON.stringify(response), {
				status: 200,
				headers: {
					'Content-Type': 'application/json',
					...responseHeaders,
				},
			});
		}

		return new Response(null, {
			status: 204,
			headers: responseHeaders,
		});
	} catch (error: unknown) {
		console.error('Message handling error:', error);
		const errorResponse = {
			jsonrpc: '2.0',
			error: {
				code: -32603,
				message: error instanceof Error ? error.message : 'Internal error',
			},
		};
		return new Response(JSON.stringify(errorResponse), {
			status: 500,
			headers: {
				'Content-Type': 'application/json',
				...responseHeaders,
			},
		});
	}
}

// Streamable HTTP MCP transport handler
async function handleMcpRequest(request: Request, corsHeaders: Record<string, string>, env: Env): Promise<Response> {
	const sessionIdHeader = request.headers.get(MCP_SESSION_HEADER);

	// Handle session termination
	if (request.method === 'DELETE') {
		if (sessionIdHeader && isValidMcpSessionId(sessionIdHeader)) {
			return new Response(null, { status: 200, headers: corsHeaders });
		}
		return new Response(null, { status: 404, headers: corsHeaders });
	}

	// Parse body early to check method
	const body = await request.text();
	let message: { method?: string; id?: unknown };
	try {
		message = JSON.parse(body);
	} catch {
		return new Response(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }), {
			status: 400,
			headers: { 'Content-Type': 'application/json', ...corsHeaders },
		});
	}

	// Generate session ID on initialize; require it on all other methods
	let mcpSessionId: string | null = sessionIdHeader;
	if (message.method === 'initialize') {
		mcpSessionId = crypto.randomUUID();
	} else if (!sessionIdHeader || !isValidMcpSessionId(sessionIdHeader)) {
		const errorMessage = sessionIdHeader ? 'Invalid Mcp-Session-Id' : 'Mcp-Session-Id header required';
		return new Response(JSON.stringify({ error: errorMessage }), {
			status: 400,
			headers: { 'Content-Type': 'application/json', ...corsHeaders },
		});
	}

	// Attach session ID to response headers
	const responseHeaders: Record<string, string> = { ...corsHeaders };
	if (mcpSessionId) {
		responseHeaders[MCP_SESSION_HEADER] = mcpSessionId;
	}

	return handleMessageFromBody(body, responseHeaders, null, env, 'mcp POST', mcpSessionId);
}
