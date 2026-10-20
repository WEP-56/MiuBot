import { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

const base = (size = 16): SVGProps<SVGSVGElement> => ({
  width: size,
  height: size,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.75,
  strokeLinecap: "round",
  strokeLinejoin: "round",
});

export const Icon = {
  // Cute Robot Head like in the top left brand and card icon
  BotFace: ({ size = 16, ...p }: IconProps) => (
    <svg {...base(size)} {...p}>
      <rect x="3" y="6" width="18" height="13" rx="4" />
      <circle cx="8.5" cy="12.5" r="1.3" fill="currentColor" />
      <circle cx="15.5" cy="12.5" r="1.3" fill="currentColor" />
      <path d="M12 2v4" />
      <path d="M1 12h2M21 12h2" />
    </svg>
  ),
  Dashboard: ({ size = 16, ...p }: IconProps) => (
    <svg {...base(size)} {...p}>
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" />
    </svg>
  ),
  Antenna: ({ size = 16, ...p }: IconProps) => (
    <svg {...base(size)} {...p}>
      <path d="M4 11a8 8 0 0 1 16 0" />
      <path d="M7 14a4 4 0 0 1 10 0" />
      <circle cx="12" cy="18" r="1.5" fill="currentColor" />
    </svg>
  ),
  Provider: ({ size = 16, ...p }: IconProps) => (
    <svg {...base(size)} {...p}>
      <rect x="5" y="5" width="14" height="14" rx="2" />
      <path d="M9 9h6v6H9z" />
      <path d="M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3" />
    </svg>
  ),
  Persona: ({ size = 16, ...p }: IconProps) => (
    <svg {...base(size)} {...p}>
      <circle cx="12" cy="12" r="9" />
      <circle cx="9" cy="10" r="1.2" fill="currentColor" />
      <circle cx="15" cy="10" r="1.2" fill="currentColor" />
      <path d="M8 15a4 4 0 0 0 8 0" />
    </svg>
  ),
  Chat: ({ size = 16, ...p }: IconProps) => (
    <svg {...base(size)} {...p}>
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </svg>
  ),
  Users: ({ size = 16, ...p }: IconProps) => (
    <svg {...base(size)} {...p}>
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  ),
  Flask: ({ size = 16, ...p }: IconProps) => (
    <svg {...base(size)} {...p}>
      <path d="M10 2v5.5L4 18a2 2 0 0 0 1.7 3h12.6a2 2 0 0 0 1.7-3L14 7.5V2" />
      <path d="M8.5 2h7" />
      <path d="M7 16h10" />
    </svg>
  ),
  Scroll: ({ size = 16, ...p }: IconProps) => (
    <svg {...base(size)} {...p}>
      <path d="M19 20H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2z" />
      <path d="M8 7h8M8 11h8M8 15h5" />
    </svg>
  ),
  Gear: ({ size = 16, ...p }: IconProps) => (
    <svg {...base(size)} {...p}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  ),
  ChevronDown: ({ size = 16, ...p }: IconProps) => (
    <svg {...base(size)} {...p}><path d="M6 9l6 6 6-6" /></svg>
  ),
  ChevronRight: ({ size = 16, ...p }: IconProps) => (
    <svg {...base(size)} {...p}><path d="M9 18l6-6-6-6" /></svg>
  ),
  ExternalLink: ({ size = 16, ...p }: IconProps) => (
    <svg {...base(size)} {...p}>
      <path d="M7 17L17 7M7 7h10v10" />
    </svg>
  ),
  DotsHorizontal: ({ size = 16, ...p }: IconProps) => (
    <svg {...base(size)} {...p}>
      <circle cx="5" cy="12" r="1.5" fill="currentColor" />
      <circle cx="12" cy="12" r="1.5" fill="currentColor" />
      <circle cx="19" cy="12" r="1.5" fill="currentColor" />
    </svg>
  ),
  MessageCircle: ({ size = 16, ...p }: IconProps) => (
    <svg {...base(size)} {...p}>
      <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
    </svg>
  ),
  Zap: ({ size = 16, ...p }: IconProps) => (
    <svg {...base(size)} {...p}>
      <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
    </svg>
  ),
  BotCircle: ({ size = 16, ...p }: IconProps) => (
    <svg {...base(size)} {...p}>
      <rect x="4" y="6" width="16" height="12" rx="3" />
      <circle cx="9" cy="12" r="1" fill="currentColor" />
      <circle cx="15" cy="12" r="1" fill="currentColor" />
      <path d="M12 2v4" />
    </svg>
  ),
  CheckCircle: ({ size = 16, ...p }: IconProps) => (
    <svg {...base(size)} {...p}>
      <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
      <polyline points="22 4 12 14.01 9 11.01" />
    </svg>
  ),
  Plus: ({ size = 16, ...p }: IconProps) => (
    <svg {...base(size)} {...p}>
      <path d="M12 5v14M5 12h14" />
    </svg>
  ),
  Search: ({ size = 16, ...p }: IconProps) => (
    <svg {...base(size)} {...p}>
      <circle cx="11" cy="11" r="8" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
  ),
  Send: ({ size = 16, ...p }: IconProps) => (
    <svg {...base(size)} {...p}>
      <line x1="22" y1="2" x2="11" y2="13" />
      <polygon points="22 2 15 22 11 13 2 9 22 2" />
    </svg>
  ),
  Refresh: ({ size = 16, ...p }: IconProps) => (
    <svg {...base(size)} {...p}>
      <path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-1.19" />
    </svg>
  ),
  Image: ({ size = 16, ...p }: IconProps) => (
    <svg {...base(size)} {...p}>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <circle cx="8.5" cy="8.5" r="1.5" fill="currentColor" />
      <polyline points="21 15 16 10 5 21" />
    </svg>
  ),
  Check: ({ size = 16, ...p }: IconProps) => (
    <svg {...base(size)} {...p}>
      <polyline points="20 6 9 17 4 12" />
    </svg>
  ),
  X: ({ size = 16, ...p }: IconProps) => (
    <svg {...base(size)} {...p}>
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  ),
  Sparkles: ({ size = 16, ...p }: IconProps) => (
    <svg {...base(size)} {...p}>
      <path d="M12 3l1.5 4.5L18 9l-4.5 1.5L12 15l-1.5-4.5L6 9l4.5-1.5z" />
    </svg>
  ),
  Eye: ({ size = 16, ...p }: IconProps) => (
    <svg {...base(size)} {...p}>
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  ),
  Copy: ({ size = 16, ...p }: IconProps) => (
    <svg {...base(size)} {...p}>
      <rect x="9" y="9" width="13" height="13" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  ),
  Import: ({ size = 16, ...p }: IconProps) => (
    <svg {...base(size)} {...p}>
      <path d="M12 3v12M7 10l5 5 5-5M4 21h16" />
    </svg>
  ),
  Export: ({ size = 16, ...p }: IconProps) => (
    <svg {...base(size)} {...p}>
      <path d="M12 21V9M7 14l5-5 5 5M4 3h16" />
    </svg>
  ),
  Database: ({ size = 16, ...p }: IconProps) => (
    <svg {...base(size)} {...p}>
      <ellipse cx="12" cy="5" rx="9" ry="3" />
      <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" />
      <path d="M3 12c0 1.66 4 3 9 3s9-1.34 9-3" />
    </svg>
  ),
  Book: ({ size = 16, ...p }: IconProps) => (
    <svg {...base(size)} {...p}>
      <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
      <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
    </svg>
  ),
  Filter: ({ size = 16, ...p }: IconProps) => (
    <svg {...base(size)} {...p}>
      <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" />
    </svg>
  ),
  Play: ({ size = 16, ...p }: IconProps) => (
    <svg {...base(size)} {...p}>
      <polygon points="5 3 19 12 5 21 5 3" />
    </svg>
  ),
  Home: ({ size = 16, ...p }: IconProps) => (
    <svg {...base(size)} {...p}><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></svg>
  ),
  Cube: ({ size = 16, ...p }: IconProps) => (
    <svg {...base(size)} {...p}><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" /></svg>
  ),
  User: ({ size = 16, ...p }: IconProps) => (
    <svg {...base(size)} {...p}><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" /></svg>
  ),
  Wrench: ({ size = 16, ...p }: IconProps) => (
    <svg {...base(size)} {...p}><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" /></svg>
  ),
  Settings: ({ size = 16, ...p }: IconProps) => (
    <svg {...base(size)} {...p}><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" /></svg>
  ),
  Bolt: ({ size = 16, ...p }: IconProps) => (
    <svg {...base(size)} {...p}><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" /></svg>
  ),
  Plug: ({ size = 16, ...p }: IconProps) => (
    <svg {...base(size)} {...p}><path d="M12 22v-5M9 8V2M15 8V2M6 8v5a6 6 0 0 0 12 0V8z" /></svg>
  ),
  More: ({ size = 16, ...p }: IconProps) => (
    <svg {...base(size)} {...p}><circle cx="12" cy="12" r="1.5" fill="currentColor"/><circle cx="19" cy="12" r="1.5" fill="currentColor"/><circle cx="5" cy="12" r="1.5" fill="currentColor"/></svg>
  ),
  Info: ({ size = 16, ...p }: IconProps) => (
    <svg {...base(size)} {...p}><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>
  ),
  Moon: ({ size = 16, ...p }: IconProps) => (
    <svg {...base(size)} {...p}><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>
  ),
  Sun: ({ size = 16, ...p }: IconProps) => (
    <svg {...base(size)} {...p}><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/></svg>
  ),
};
