### Secret Management

- Okay, let me clarify. I see you struggle to understand the secret management implementation. When we used the Supabase cloud backend pretty much all the secrets were set up in that cloud: 
    - For both web and mobile app we already set up the initial Supabase secrets in the GitHub Actions secrets just to be able to access the Supabase Vault and the Supabase edge function secrets. 
    - Since we use self-hosted Supabase now I wanna make sure we use the same approach — establish parity between the cloud and self-hosted Supabase. It's the secure and very convenient way to manage secrets.
    - Check out our backend repo Users/organic/dev/work/foodshare/foodshare-backend, bring changes to then commint and push them respectively.
    - Again, the experience must match the Supabase cloud, but with our self-hosted stack. 


