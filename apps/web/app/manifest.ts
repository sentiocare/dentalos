import type { MetadataRoute } from "next";

// Installable on Android as a home-screen app (Build Prompt §5.15).
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Sentio Dental OS",
    short_name: "Sentio",
    description: "Front desk and practice automation for dental clinics",
    start_url: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#ffffff",
    theme_color: "#0f766e",
    icons: [
      { src: "/icon.svg", sizes: "any", type: "image/svg+xml" },
      { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
      { src: "/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
