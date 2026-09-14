import type { RouteObject } from "react-router-dom";
import Selector from "./routes/Selector";
import BoardDetail from "./routes/BoardDetail";
import Layout from "./routes/Layout";
import Rangefinders from "./routes/Rangefinders";
import RangefinderDetail from "./routes/RangefinderDetail";
import AdminLayout from "./admin/AdminLayout";
import AdminBoard from "./admin/AdminBoard";

// Shared by the browser entry (main.tsx) and the build-time pre-renderer
// (entry-server.tsx), so a route can never exist in one and not the other.
export const routes: RouteObject[] = [
  {
    path: "/",
    element: <Layout />,
    children: [
      { index: true, element: <Selector /> },
      { path: "board/:slug", element: <BoardDetail /> },
      { path: "rangefinders", element: <Rangefinders /> },
      { path: "rangefinder/:id", element: <RangefinderDetail /> },
      {
        path: "admin",
        element: <AdminLayout />,
        children: [{ path: ":slug", element: <AdminBoard /> }],
      },
    ],
  },
];
