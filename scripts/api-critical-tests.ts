type EndpointCheck = {
  name: string;
  path: string;
  method?: "GET" | "POST" | "PATCH";
  expected: number[];
};

function getBaseUrl() {
  const raw = process.env.API_BASE_URL ?? "http://localhost:4000";
  return raw.replace(/\/+$/, "");
}

async function runCheck(baseUrl: string, check: EndpointCheck) {
  const url = `${baseUrl}${check.path}`;
  const response = await fetch(url, {
    method: check.method ?? "GET",
    headers: {
      "Content-Type": "application/json",
    },
  });

  const ok = check.expected.includes(response.status);
  return {
    ok,
    status: response.status,
    name: check.name,
    expected: check.expected,
    path: check.path,
  };
}

async function main() {
  const baseUrl = getBaseUrl();

  const checks: EndpointCheck[] = [
    { name: "Health", path: "/healthz", expected: [200] },
    { name: "Public bounties", path: "/api/bounties?status=open&limit=5", expected: [200] },
    { name: "Public freelancers", path: "/api/freelancers?limit=5", expected: [200] },
    { name: "Protected users/me", path: "/api/users/me", expected: [401, 403] },
    { name: "Protected users/summary", path: "/api/users/me/summary", expected: [401, 403] },
    { name: "Protected projects", path: "/api/projects", expected: [401, 403] },
    { name: "Protected conversations", path: "/api/projects/conversations", expected: [401, 403] },
    { name: "Protected disputes", path: "/api/disputes?scope=my", expected: [401, 403] },
    { name: "Protected auth/me", path: "/api/auth/me", expected: [401, 403] },
    {
      name: "Protected bounty raise amount",
      method: "PATCH",
      path: "/api/bounties/44444444-4444-4444-4444-444444444444/raise-amount",
      expected: [401, 403, 404],
    },
  ];

  const results = await Promise.all(checks.map((check) => runCheck(baseUrl, check)));

  let failures = 0;
  for (const result of results) {
    if (result.ok) {
      console.log(`PASS ${result.name} -> ${result.status}`);
      continue;
    }

    failures += 1;
    console.error(
      `FAIL ${result.name} -> ${result.status} (expected ${result.expected.join("/")}) [${result.path}]`,
    );
  }

  if (failures > 0) {
    console.error(`\nCritical API tests failed: ${failures}`);
    process.exit(1);
  }

  console.log("\nCritical API tests passed.");
}

void main();
