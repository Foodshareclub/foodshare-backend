/**
 * Forum API v1
 *
 * REST API for community forum operations.
 * Supports Web, iOS, and Android clients with consistent interface.
 *
 * Endpoints:
 * - GET    /api-v1-forum                          - Feed listing
 * - GET    /api-v1-forum?id=<id>                  - Post detail
 * - GET    /api-v1-forum?action=categories        - List categories
 * - GET    /api-v1-forum?action=search&q=<query>  - Search posts
 * - GET    /api-v1-forum?action=drafts            - User drafts (auth)
 * - GET    /api-v1-forum?action=bookmarks         - User bookmarks (auth)
 * - GET    /api-v1-forum?action=unread            - Unread posts (auth)
 * - GET    /api-v1-forum?action=series&id=<id>    - Series detail
 * - GET    /api-v1-forum?action=comments&id=<id>  - List comments for post
 * - POST   /api-v1-forum?action=create            - Create post
 * - POST   /api-v1-forum?action=comment           - Add comment
 * - POST   /api-v1-forum?action=like              - Toggle like
 * - POST   /api-v1-forum?action=bookmark          - Toggle bookmark
 * - POST   /api-v1-forum?action=react             - Toggle reaction
 * - POST   /api-v1-forum?action=subscribe         - Toggle subscription
 * - POST   /api-v1-forum?action=report            - Report content
 * - POST   /api-v1-forum?action=draft             - Save draft
 * - POST   /api-v1-forum?action=poll              - Create poll
 * - POST   /api-v1-forum?action=vote              - Vote on poll
 * - POST   /api-v1-forum?action=view              - Record view
 * - POST   /api-v1-forum?action=pin               - Toggle pin
 * - POST   /api-v1-forum?action=lock              - Toggle lock (mod)
 * - POST   /api-v1-forum?action=remove            - Remove post (mod)
 * - POST   /api-v1-forum?action=feature           - Feature post (mod)
 * - POST   /api-v1-forum?action=best-answer       - Mark best answer
 * - PUT    /api-v1-forum?id=<id>                  - Update post
 * - PUT    /api-v1-forum?action=comment&id=<id>   - Update comment
 * - DELETE /api-v1-forum?id=<id>                  - Delete post
 * - DELETE /api-v1-forum?action=comment&id=<id>   - Delete comment
 * - DELETE /api-v1-forum?action=draft&id=<id>     - Delete draft
 *
 * @module api-v1-forum
 */

import { uuidSchema, z } from "../_shared/schemas/common.ts";
import { createAPIHandler, type HandlerContext } from "../_shared/api-handler.ts";
import { createHealthHandler } from "../_shared/health-handler.ts";
import { ValidationError } from "../_shared/errors.ts";

// Thread handlers
import {
  createPost,
  deletePost,
  featurePost,
  getCategories,
  getFeed,
  getPostDetail,
  getSeries,
  getUnread,
  recordView,
  removePost,
  searchPosts,
  toggleLock,
  togglePin,
  updatePost,
} from "./lib/threads.ts";

// Comment handlers
import {
  createComment,
  deleteComment,
  getComments,
  markBestAnswer,
  updateComment,
} from "./lib/comments.ts";

// Reaction/engagement handlers
import {
  createPoll,
  deleteDraft,
  getBookmarks,
  getDrafts,
  saveDraft,
  submitReport,
  toggleBookmark,
  toggleLike,
  toggleReaction,
  toggleSubscription,
  votePoll,
} from "./lib/reactions.ts";

const VERSION = "1.0.0";
const healthCheck = createHealthHandler("api-v1-forum", VERSION);

// =============================================================================
// Query Schema
// =============================================================================

const forumQuerySchema = z.object({
  action: z.enum([
    "categories",
    "search",
    "drafts",
    "bookmarks",
    "unread",
    "series",
    "comments",
    "create",
    "comment",
    "like",
    "bookmark",
    "react",
    "subscribe",
    "report",
    "draft",
    "poll",
    "vote",
    "view",
    "pin",
    "lock",
    "remove",
    "feature",
    "best-answer",
  ]).optional(),
  id: z.string().optional(),
  q: z.string().optional(),
  categoryId: z.string().optional(),
  postType: z.enum(["discussion", "question", "announcement", "guide"]).optional(),
  sortBy: z.enum(["recent", "popular", "trending", "unanswered"]).optional(),
  authorId: uuidSchema.optional(),
  dateFrom: z.string().optional(),
  dateTo: z.string().optional(),
  tags: z.string().optional(), // comma-separated tag IDs
  limit: z.string().optional(),
  offset: z.string().optional(),
});

export type ForumQuery = z.infer<typeof forumQuerySchema>;

// =============================================================================
// Route Dispatchers
// =============================================================================

async function handleGet(ctx: HandlerContext<unknown, ForumQuery>): Promise<Response> {
  // Health check
  const url = new URL(ctx.request.url);
  if (url.pathname.endsWith("/health")) {
    return healthCheck(ctx);
  }

  const { query } = ctx;

  // Post detail by id (no action)
  if (query.id && !query.action) {
    return getPostDetail(ctx);
  }

  switch (query.action) {
    case "categories":
      return getCategories(ctx);
    case "search":
      return searchPosts(ctx);
    case "drafts":
      return getDrafts(ctx);
    case "bookmarks":
      return getBookmarks(ctx);
    case "unread":
      return getUnread(ctx);
    case "series":
      return getSeries(ctx);
    case "comments":
      return getComments(ctx);
    default:
      return getFeed(ctx);
  }
}

async function handlePost(ctx: HandlerContext<unknown, ForumQuery>): Promise<Response> {
  const { query } = ctx;

  switch (query.action) {
    case "create":
      return createPost(ctx);
    case "comment":
      return createComment(ctx);
    case "like":
      return toggleLike(ctx);
    case "bookmark":
      return toggleBookmark(ctx);
    case "react":
      return toggleReaction(ctx);
    case "subscribe":
      return toggleSubscription(ctx);
    case "report":
      return submitReport(ctx);
    case "draft":
      return saveDraft(ctx);
    case "poll":
      return createPoll(ctx);
    case "vote":
      return votePoll(ctx);
    case "view":
      return recordView(ctx);
    case "pin":
      return togglePin(ctx);
    case "lock":
      return toggleLock(ctx);
    case "remove":
      return removePost(ctx);
    case "feature":
      return featurePost(ctx);
    case "best-answer":
      return markBestAnswer(ctx);
    default:
      throw new ValidationError(
        "action query param required (create, comment, like, bookmark, react, subscribe, report, draft, poll, vote, view, pin, lock, remove, feature, best-answer)",
      );
  }
}

async function handlePut(ctx: HandlerContext<unknown, ForumQuery>): Promise<Response> {
  const { query } = ctx;

  if (!query.id) {
    throw new ValidationError("id query param required for PUT");
  }

  if (query.action === "comment") {
    return updateComment(ctx);
  }

  return updatePost(ctx);
}

async function handleDelete(ctx: HandlerContext<unknown, ForumQuery>): Promise<Response> {
  const { query } = ctx;

  if (!query.id && query.action !== "draft") {
    throw new ValidationError("id query param required for DELETE");
  }

  switch (query.action) {
    case "comment":
      return deleteComment(ctx);
    case "draft":
      return deleteDraft(ctx);
    default:
      return deletePost(ctx);
  }
}

// =============================================================================
// Export Handler
// =============================================================================

Deno.serve(createAPIHandler({
  service: "api-v1-forum",
  version: VERSION,
  requireAuth: false, // GET is public, mutations require auth
  csrf: true,
  rateLimit: {
    limit: 120,
    windowMs: 60000,
    keyBy: "ip",
  },
  routes: {
    GET: {
      querySchema: forumQuerySchema,
      handler: handleGet,
      requireAuth: false,
    },
    POST: {
      querySchema: forumQuerySchema,
      handler: handlePost,
      requireAuth: true,
    },
    PUT: {
      querySchema: forumQuerySchema,
      handler: handlePut,
      requireAuth: true,
    },
    DELETE: {
      querySchema: forumQuerySchema,
      handler: handleDelete,
      requireAuth: true,
    },
  },
}));
