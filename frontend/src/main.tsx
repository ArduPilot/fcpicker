import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, RouterProvider } from "react-router-dom";
import "./index.css";
import "./App.css";
import { routes } from "./routes-config";

// BASE_URL is "/" at the domain root and "/fcpicker/" when served under a
// sub-path; the router has to know so its links match the served URLs.
const router = createBrowserRouter(routes, {
  basename: import.meta.env.BASE_URL,
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
