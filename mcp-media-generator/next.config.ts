import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // السماح ببث SSE على مسار /mcp — لا حاجة لخيارات خاصة لأن Next.js App Router
  // يدعم Streaming Responses افتراضيًا في runtime = "nodejs".
  experimental: {
    // تقليل حجم حزمة MCP SDK في الإنتاج
    optimizePackageImports: ["lucide-react"],
  },
};

export default nextConfig;
