import { Route, Routes } from "react-router-dom";
import Layout from "./components/Layout";
import Home from "./pages/Home";
import Scripts from "./pages/Scripts";
import Launch from "./pages/Launch";
import Jobs from "./pages/Jobs";
import JobLog from "./pages/JobLog";

export default function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route path="/" element={<Home />} />
        <Route path="/ws/:wsId" element={<Scripts />} />
        <Route path="/ws/:wsId/run" element={<Launch />} />
        <Route path="/jobs" element={<Jobs />} />
        <Route path="/jobs/:jobId" element={<JobLog />} />
      </Route>
    </Routes>
  );
}
