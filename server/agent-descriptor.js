'use strict';
// What OpenVibe.Bench tells an agent about itself (openvibe-shared/agent-layer): /.well-known/agent.json (SEO-2).
// Every field is something this site really serves; the purpose is its own llms.txt summary.
module.exports = {
    id: "bench",
    name: "OpenVibe.Bench",
    purpose: "One AI benchmark and comparison engine for every room: blind votes, rubrics, graders, test suites and game outcomes, with reproducible pinned rounds and an open dataset per kind.",
    home: "https://bench.openvibe.services",
    site: "bench.openvibe.services",
    api: "/api/v1",
    docs: "/docs",
    mcp: { url: "/mcp" },
    openapi: '/openapi.json',
    policy: {
        auth: ["none", "Network OIDC"],
    },
};
