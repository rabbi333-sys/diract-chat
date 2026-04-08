export type MainDbType = 'supabase' | 'postgresql' | 'mysql' | 'mongodb' | 'redis';

export interface MainDbConnection {
  id: string;
  name: string;
  dbType: MainDbType;
  // Supabase
  url: string;
  anonKey: string;
  serviceRoleKey?: string;
  // PostgreSQL / MySQL
  host?: string;
  port?: string;
  dbUsername?: string;
  dbPassword?: string;
  dbName?: string;
  // MongoDB / Redis
  connectionString?: string;
  createdAt: string;
}

const CONNECTIONS_KEY = 'meta_db_connections';
const ACTIVE_ID_KEY = 'meta_db_active_id';
export const MAX_CONNECTIONS = 5;

export function getConnections(): MainDbConnection[] {
  try {
    const raw = localStorage.getItem(CONNECTIONS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    // Backward compat: old entries without dbType default to 'supabase'
    return parsed.map((c: MainDbConnection) => ({ dbType: 'supabase', ...c }));
  }
  catch { return []; }
}

export function getActiveConnection(): MainDbConnection | null {
  const connections = getConnections();
  const activeId = localStorage.getItem(ACTIVE_ID_KEY);
  return connections.find(c => c.id === activeId) || connections[0] || null;
}

const DB_CHANGE_EVENT = 'meta_db_change';

function notifyChange() {
  window.dispatchEvent(new CustomEvent(DB_CHANGE_EVENT));
}

export function onDbChange(handler: () => void): () => void {
  window.addEventListener(DB_CHANGE_EVENT, handler);
  return () => window.removeEventListener(DB_CHANGE_EVENT, handler);
}

export function saveConnection(conn: Omit<MainDbConnection, 'id' | 'createdAt'> & { id?: string }): MainDbConnection {
  const connections = getConnections();
  const existingIdx = conn.id ? connections.findIndex(c => c.id === conn.id) : -1;

  if (existingIdx >= 0) {
    const updated = { ...connections[existingIdx], ...conn, id: connections[existingIdx].id };
    connections[existingIdx] = updated;
    localStorage.setItem(CONNECTIONS_KEY, JSON.stringify(connections));
    notifyChange();
    return updated;
  }

  if (connections.length >= MAX_CONNECTIONS) {
    throw new Error(`Maximum ${MAX_CONNECTIONS} connections allowed`);
  }

  const newConn: MainDbConnection = {
    ...conn,
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
  };
  connections.push(newConn);
  localStorage.setItem(CONNECTIONS_KEY, JSON.stringify(connections));
  notifyChange();
  return newConn;
}

export function setActiveConnection(id: string): void {
  localStorage.setItem(ACTIVE_ID_KEY, id);
  notifyChange();
}

export function deleteConnection(id: string): void {
  const connections = getConnections().filter(c => c.id !== id);
  localStorage.setItem(CONNECTIONS_KEY, JSON.stringify(connections));
  const activeId = localStorage.getItem(ACTIVE_ID_KEY);
  if (activeId === id) {
    const next = connections[0];
    if (next) localStorage.setItem(ACTIVE_ID_KEY, next.id);
    else localStorage.removeItem(ACTIVE_ID_KEY);
  }
  notifyChange();
}

export function hasActiveConnection(): boolean {
  const conn = getActiveConnection();
  if (!conn) return false;
  if (!conn.dbType || conn.dbType === 'supabase') return !!conn.url && !!conn.anonKey;
  if (conn.dbType === 'postgresql' || conn.dbType === 'mysql') return !!conn.host;
  return !!conn.connectionString;
}

export const DB_TYPES: { value: MainDbType; icon: string; label: string; defaultPort: string }[] = [
  { value: 'supabase',    icon: '⚡', label: 'Supabase',   defaultPort: '' },
  { value: 'postgresql',  icon: '🐘', label: 'PostgreSQL', defaultPort: '5432' },
  { value: 'mysql',       icon: '🐬', label: 'MySQL',      defaultPort: '3306' },
  { value: 'mongodb',     icon: '🍃', label: 'MongoDB',    defaultPort: '27017' },
  { value: 'redis',       icon: '🔴', label: 'Redis',      defaultPort: '6379' },
];

export function getDbTypeInfo(dbType?: MainDbType) {
  return DB_TYPES.find(t => t.value === (dbType || 'supabase')) ?? DB_TYPES[0];
}

export function getConnectionDisplayUrl(conn: MainDbConnection): string {
  if (!conn.dbType || conn.dbType === 'supabase') return conn.url || '';
  if (conn.dbType === 'postgresql' || conn.dbType === 'mysql') {
    return conn.host ? `${conn.host}${conn.port ? ':' + conn.port : ''}` : '';
  }
  // MongoDB / Redis: mask URI password
  const str = conn.connectionString || '';
  return str.replace(/:([^@]+)@/, ':****@').slice(0, 60);
}
