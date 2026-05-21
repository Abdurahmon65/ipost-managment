import { Redis } from '@upstash/redis';

export const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
});

/* ---------- Keys ---------- */
const K_USERS = 'data:users';
const K_BRANCHES = 'data:branches';
const K_RECORDS = 'data:records';
const RECORDS_LIMIT = 500;

/* ---------- Users ---------- */
export async function getUsers() {
  const raw = await redis.get(K_USERS);
  if (!raw) return [];
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
}
export async function setUsers(users) {
  await redis.set(K_USERS, JSON.stringify(users));
}

/* ---------- Branches ---------- */
export async function getBranches() {
  const raw = await redis.get(K_BRANCHES);
  if (!raw) return [];
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
}
export async function setBranches(branches) {
  await redis.set(K_BRANCHES, JSON.stringify(branches));
}

/* ---------- Records (logs) ---------- */
export async function getRecords() {
  const raw = await redis.get(K_RECORDS);
  if (!raw) return [];
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
}
export async function setRecords(records) {
  await redis.set(K_RECORDS, JSON.stringify(records.slice(0, RECORDS_LIMIT)));
}
export async function appendRecord(record) {
  const records = await getRecords();
  records.unshift(record);
  await setRecords(records);
}
