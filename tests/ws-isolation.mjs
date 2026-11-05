// Verifies that WebSocket events reach only the users they belong to.
// Run after `docker compose up`: node tests/ws-isolation.mjs (Node 22+)
const GATEWAY = process.env.GATEWAY_URL || 'http://localhost:3000';
const WS_URL = `${GATEWAY.replace(/^http/, 'ws')}/ws`;
const PASSWORD = 'password123';

async function send(method, path, body, token) {
  const response = await fetch(`${GATEWAY}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${method} ${path} returned ${response.status}`);
  return response.json();
}

async function loginClient(email) {
  const { token, client } = await send('POST', '/api/auth/client/login', { email, password: PASSWORD });
  return { token, code: client.client_code };
}

function listen(registration) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(WS_URL);
    const events = [];
    socket.addEventListener('error', () => reject(new Error('WebSocket connection failed')));
    socket.addEventListener('open', () => socket.send(JSON.stringify(registration)));
    socket.addEventListener('message', ({ data }) => {
      const message = JSON.parse(data);
      if (message.type === 'registered') resolve({ socket, events });
      else if (message.type !== 'connected') events.push(message);
    });
  });
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const types = (connection) => connection.events.map((event) => event.type);

const failures = [];
function check(passed, label) {
  console.log(`  [${passed ? 'PASS' : 'FAIL'}] ${label}`);
  if (!passed) failures.push(label);
}

const owner = await loginClient('techmart@example.com');
const other = await loginClient('fashionhub@example.com');
const driver = await send('POST', '/api/auth/driver/login', { email: 'kasun@swiftlogistics.lk', password: PASSWORD });

const ownerConnection = await listen({ type: 'register_client', client_id: owner.code });
const otherConnection = await listen({ type: 'register_client', client_id: other.code });
const driverConnection = await listen({ type: 'register_driver', driver_id: driver.driver.id });

const order = await send('POST', '/api/orders', {
  pickup_address: '45 Galle Road, Colombo 03',
  delivery_address: '5 Lake Drive, Kandy',
  weight_kg: 1,
}, owner.token);
await wait(2000);

await send('PUT', '/api/packages/status', { order_code: order.order_code, status: 'loaded' }, driver.token);
await wait(1000);

check(types(ownerConnection).includes('SAGA_TRANSACTION_SUCCESS'), 'Owning client receives the saga result');
check(types(ownerConnection).includes('PACKAGE_STATUS_UPDATED'), 'Owning client receives package updates');
check(types(driverConnection).includes('NEW_ORDER_AVAILABLE'), 'Driver receives new order notices');
check(
  otherConnection.events.length === 0,
  `Other client receives nothing (got: ${types(otherConnection).join(', ') || 'none'})`,
);
check(!types(ownerConnection).includes('NEW_ORDER_AVAILABLE'), 'Clients do not receive driver-only events');

for (const connection of [ownerConnection, otherConnection, driverConnection]) connection.socket.close();
process.exit(failures.length ? 1 : 0);
