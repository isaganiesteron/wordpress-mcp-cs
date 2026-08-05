# WordPress MCP - Test Prompts

Use these prompts in ClickUp Brain (or any connected MCP client) to verify the server is working. Test in order — later steps depend on earlier ones (the create/verify/delete cycle needs the post ID from step 3).

## Smoke Test (read + full write/delete cycle)

This is the exact sequence used to verify the server end-to-end on 2026-08-05, both manually via curl and through ClickUp Brain.

### 1. List clients

**Prompt:** "Use the WordPress MCP to list every client site."

**Expected:** Calls `wp_list_clients`, returns 50+ client sites with `client_slug`, `site_url`, `seo_plugin`, `elementor` — no tokens/usernames in the response.

---

### 2. List posts on a real site

**Prompt:** "List the 3 most recent published posts on ferguson-builders using the WordPress MCP."

**Expected:** Calls `wp_list_posts` with `client: "ferguson-builders", status: "publish", per_page: 3`, returns real post titles/slugs from `fergusonbuilders.co.nz`.

---

### 3. Create a draft (safe test site)

**Prompt:** "Create a draft post on aquarium-friend titled 'MCP smoke test - safe to delete' with content '<p>Smoke test.</p>' using the WordPress MCP. Tell me the post ID."

**Expected:** Calls `wp_publish_post` with `status: "draft"`. Returns a real `post_id` — note it for steps 4-6.

---

### 4. Confirm it exists

**Prompt:** "Get post {post_id} on aquarium-friend and confirm its status."

**Expected:** Calls `wp_get_post`, returns `status: "draft"` and the title from step 3.

---

### 5. Delete it (cleanup)

**Prompt:** "Permanently delete post {post_id} on aquarium-friend using the WordPress MCP raw request tool, method DELETE, path /wp/v2/posts/{post_id}?force=true."

**Expected:** Calls `wp_raw_request`, returns `ok: true`, HTTP 200, `deleted: true`.

---

### 6. Confirm it's gone

**Prompt:** "Get post {post_id} on aquarium-friend again."

**Expected:** Calls `wp_get_post`, returns an error — HTTP 404, `rest_post_invalid_id`. This confirms cleanup actually worked, not just that the delete call returned 200.

---

## Not Yet Covered By This Smoke Test

These three tools share the same underlying request path (`resolveClient` + `wpFetch`) already proven by the steps above, but haven't been individually exercised against a live site. Test with the same draft-and-delete discipline as steps 3-6 above before relying on them broadly:

### 7. Update a post

**Prompt:** "Create a draft on aquarium-friend, then update its content using the WordPress MCP update tool, then delete it."

**Expected:** Calls `wp_publish_post` → `wp_update_post` (new `content`) → `wp_get_post` to confirm the new content → `wp_raw_request` DELETE to clean up.

### 8. Set a featured image

**Prompt:** "Create a draft on aquarium-friend, set its featured image from [a real publicly-reachable image URL], confirm it, then delete the draft."

**Expected:** Calls `wp_publish_post` → `wp_set_featured_image` (uploads the image to the media library, assigns `featured_media`) → `wp_get_post` to confirm `featured_media` is non-zero → `wp_raw_request` DELETE to clean up. Note: this also creates a media library attachment, which the DELETE on the post does *not* remove — check `/wp-admin/upload.php` if you want that cleaned up too.

### 9. Set RankMath SEO meta

**Prompt:** "Create a draft on aquarium-friend, set its RankMath SEO title and focus keyword using the WordPress MCP, confirm it landed, then delete the draft."

**Expected:** Calls `wp_publish_post` → `wp_set_seo_meta` → `wp_get_post` to check the `meta.rank_math_title`/`rank_math_focus_keyword` fields came back set → `wp_raw_request` DELETE to clean up. If the meta doesn't stick, that site likely doesn't have `show_in_rest` enabled for those RankMath fields — not a bug in this Worker, see README's Known Risks section.

---

## Guardrails While Testing

- Only use `aquarium-friend` (or another explicitly-approved low-risk site) for write tests — never `wp_publish_post` with `status: "publish"` or `"future"` against a real client's live site during testing.
- Always clean up test posts (`wp_raw_request` DELETE with `force=true`) — don't leave test drafts sitting in a client's WordPress admin.
- If any step fails, stop and get the exact error message before retrying — don't loop on the same call.
