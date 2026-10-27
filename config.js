// Conexión a Shop Car (Supabase). La llave "anon" es pública por diseño: lo que cada
// usuario puede ver o escribir lo deciden las reglas (RLS) de la base, no esta llave.
// En esta computadora (localhost) la app usa el Supabase local de pruebas.
window.SHOPCAR = ['localhost', '127.0.0.1'].includes(location.hostname)
  ? {
      url: 'http://127.0.0.1:54321',
      anonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0',
    }
  : {
      url: '',     // Supabase de Shop Car en producción (pendiente)
      anonKey: '',
    };
