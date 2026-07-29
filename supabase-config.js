// Madzo — Supabase client config. Loaded after the supabase-js UMD script.
(function () {
  var SUPABASE_URL = 'https://brncpyzxcergxjpgyeob.supabase.co';
  var SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJybmNweXp4Y2VyZ3hqcGd5ZW9iIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODUxNjkzNjAsImV4cCI6MjEwMDc0NTM2MH0.TCFXvwuV1aCHlieGUXBnwSk8M2sZNCjDPYNKqLy13tY';
  var client = null;
  window.getSupabase = function () {
    if (!client) client = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    return client;
  };
})();
