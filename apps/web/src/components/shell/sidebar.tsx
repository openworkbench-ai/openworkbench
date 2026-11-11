import { useEffect, useState } from "react";
import { NavLink } from "react-router-dom";
import {
  LayoutGrid,
  LogOut,
  MessageSquare,
  PanelLeftClose,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { fetchApps, logout, type AuthUser } from "@/lib/api";
import { ThemeToggle } from "@/components/shell/theme-toggle";

export function Sidebar({ user }: { user: AuthUser | null }) {
  const [appCount, setAppCount] = useState(0);
  useEffect(() => {
    const load = () => {
      void fetchApps()
        .then(({ apps }) => setAppCount(apps.length))
        .catch(() => {});
    };
    load();
    window.addEventListener("owb:apps-changed", load);
    return () => window.removeEventListener("owb:apps-changed", load);
  }, []);
  return (
    <aside className="workbench-rail">
      <NavLink
        to="/apps"
        className="rail-brand"
        aria-label="Open Workbench"
        title="Open Workbench"
      >
        <span>o</span>
        <i />
      </NavLink>
      <div className="rail-divider" />
      <nav aria-label="Main navigation">
        {[
          { to: "/", label: "Chat", icon: MessageSquare },
          { to: "/apps", label: "Apps", icon: LayoutGrid },
        ].map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.to === "/"}
            className={({ isActive }) =>
              cn("rail-destination", isActive && "active")
            }
          >
            <item.icon size={19} strokeWidth={1.6} />
            <span>{item.label}</span>
            {item.label === "Apps" && appCount > 0 && <i>{appCount}</i>}
          </NavLink>
        ))}
      </nav>
      <div className="rail-footer">
        <span className="rail-flower" title="A little space to make things">
          ✻
        </span>
        <ThemeToggle />
        <button
          aria-label="Sign out"
          title={`Sign out ${user?.email ?? ""}`}
          onClick={() => void logout()}
        >
          <LogOut size={16} />
        </button>
        <span className="rail-avatar" title={user?.email}>
          {user?.email.charAt(0).toUpperCase() ?? "U"}
        </span>
        <PanelLeftClose size={13} className="rail-bottom-icon" />
      </div>
    </aside>
  );
}
