import { createClient } from "@supabase/supabase-js";

// MotherDuck REST API helper
async function executeMotherDuckQuery(token: string, sql: string): Promise<unknown> {
  const response = await fetch("https://api.motherduck.com/v1/sql", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ sql }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`MotherDuck API error: ${response.status} - ${errorText}`);
  }

  return response.json();
}

Deno.serve(async (_req) => {
  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const mdToken = Deno.env.get("MOTHERDUCK_TOKEN")!;

    if (!mdToken) throw new Error("Missing MOTHERDUCK_TOKEN");

    const supabase = createClient(supabaseUrl, supabaseKey);

    // 1. Fetch Snapshot Data from Supabase
    const { data: profiles, error: profilesError } = await supabase
      .from("profiles")
      .select("id, created_at, role, full_name, email");

    if (profilesError) throw profilesError;

    const { data: posts, error: postsError } = await supabase
      .from("posts")
      .select("id, created_at, title, status, profile_id, type");

    if (postsError) throw postsError;

    console.log(`Fetched ${profiles.length} profiles and ${posts.length} posts.`);

    // Safe string escape function
    const esc = (s: unknown) =>
      s === null || s === undefined ? "NULL" : `'${String(s).replace(/'/g, "''")}'`;

    // 2. Sync Users (Full Replenish / Snapshot)
    await executeMotherDuckQuery(
      mdToken,
      `
      CREATE TABLE IF NOT EXISTS full_users (
        id VARCHAR,
        created_at TIMESTAMP,
        role VARCHAR,
        full_name VARCHAR,
        email VARCHAR,
        synced_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `
    );

    await executeMotherDuckQuery(mdToken, "DELETE FROM full_users");

    // Bulk insert users in batches to avoid query size limits
    const BATCH_SIZE = 500;
    if (profiles.length > 0) {
      for (let i = 0; i < profiles.length; i += BATCH_SIZE) {
        const batch = profiles.slice(i, i + BATCH_SIZE);
        const values = batch
          .map(
            (p) =>
              `(${esc(p.id)}, ${esc(p.created_at)}, ${esc(p.role)}, ${esc(p.full_name)}, ${esc(p.email)}, CURRENT_TIMESTAMP)`
          )
          .join(",");

        await executeMotherDuckQuery(mdToken, `INSERT INTO full_users VALUES ${values}`);
      }
    }

    // 3. Sync Listings
    await executeMotherDuckQuery(
      mdToken,
      `
      CREATE TABLE IF NOT EXISTS full_listings (
        id BIGINT,
        created_at TIMESTAMP,
        title VARCHAR,
        status VARCHAR,
        profile_id VARCHAR,
        type VARCHAR,
        synced_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `
    );

    await executeMotherDuckQuery(mdToken, "DELETE FROM full_listings");

    if (posts.length > 0) {
      for (let i = 0; i < posts.length; i += BATCH_SIZE) {
        const batch = posts.slice(i, i + BATCH_SIZE);
        const values = batch
          .map(
            (p) =>
              `(${p.id}, ${esc(p.created_at)}, ${esc(p.title)}, ${esc(p.status)}, ${esc(p.profile_id)}, ${esc(p.type)}, CURRENT_TIMESTAMP)`
          )
          .join(",");

        await executeMotherDuckQuery(mdToken, `INSERT INTO full_listings VALUES ${values}`);
      }
    }

    return new Response(
      JSON.stringify({
        success: true,
        synced: { users: profiles.length, listings: posts.length },
      }),
      { headers: { "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("Sync Error:", error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});
