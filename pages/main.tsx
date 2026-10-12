import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import Notebook from "../app/notebook";
import "../app/globals.css";

const root = document.getElementById("root");
if (!root) throw new Error("页面挂载点不存在，请重新加载。");

createRoot(root).render(
  <StrictMode>
    <Notebook
      authenticated={true}
      displayName="本地书房"
      storageMode="local"
      basePath={import.meta.env.BASE_URL}
    />
  </StrictMode>,
);
