// Where the app finds its Supabase project. On your Mac (127.0.0.1 or
// localhost) it's the local copy; anywhere else, the online project.
// Publishable keys are meant to be public: they only let a browser reach the
// database, and the database's access rules decide what each signed-in user
// can see. Never put a secret or service role key here.
window.STA_CONFIG = ['127.0.0.1', 'localhost'].includes(location.hostname)
  ? { supabaseUrl: 'http://127.0.0.1:54321', publishableKey: 'sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH' }
  : { supabaseUrl: 'https://cztevomhnflvzglrqvfg.supabase.co', publishableKey: 'sb_publishable_nCGiFJ-uJSPVdGkg_0hjeQ_cpDjlvlI' };
