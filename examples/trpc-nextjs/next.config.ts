import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The Neo4j driver stays a Node.js dependency of the server bundle.
  serverExternalPackages: ["neo4j-driver"],
};

export default nextConfig;
