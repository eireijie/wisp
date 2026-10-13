/**
 * Warren's icons: Phosphor (MIT, phosphoricons.com), softer and rounder than the usual set.
 * Exported under the names the app uses, so a screen just imports what it means ("Settings",
 * "Server") and the drawing can change here. A heavier `strokeWidth` draws the bold weight.
 */
import type { ComponentType } from "react";
import {
  ArrowClockwise,
  ArrowCounterClockwise,
  ArrowDown as PArrowDown,
  ArrowElbowDownLeft,
  ArrowLeft as PArrowLeft,
  ArrowRight as PArrowRight,
  ArrowSquareOut,
  ArrowUp as PArrowUp,
  At,
  Bell as PBell,
  Binoculars,
  BookOpen as PBookOpen,
  Brain as PBrain,
  Buildings,
  CalendarDots,
  CaretDown,
  CaretLeft,
  CaretRight,
  ChatsTeardrop,
  ChatTeardrop,
  Check as PCheck,
  CircleHalf,
  CircleNotch,
  ClipboardText,
  Clock as PClock,
  ClockCounterClockwise,
  Cloud as PCloud,
  Copy as PCopy,
  Cpu as PCpu,
  Crown as PCrown,
  Database as PDatabase,
  DeviceMobile,
  DotsSixVertical,
  DotsThree,
  DownloadSimple,
  Eye as PEye,
  EyeSlash,
  FilePlus as PFilePlus,
  FileText as PFileText,
  Folder as PFolder,
  FolderPlus as PFolderPlus,
  Gear,
  GearSix,
  Ghost as PGhost,
  GitBranch as PGitBranch,
  GitCommit,
  GitMerge as PGitMerge,
  GitPullRequest as PGitPullRequest,
  Hand as PHand,
  HandArrowDown,
  HardDrives,
  Hash as PHash,
  Key,
  Laptop as PLaptop,
  Lightning,
  Link,
  ListChecks as PListChecks,
  LockSimple,
  LockSimpleOpen,
  MagnifyingGlass,
  Monitor as PMonitor,
  Moon as PMoon,
  NotePencil,
  Palette as PPalette,
  Paperclip as PPaperclip,
  Pause as PPause,
  PencilSimple,
  Play as PPlay,
  Plug as PPlug,
  Plus as PPlus,
  Power as PPower,
  Pulse,
  PushPin,
  PushPinSlash,
  Record,
  Robot,
  Scroll,
  SealQuestion,
  ShieldWarning,
  Shield as PShield,
  Shuffle as PShuffle,
  SidebarSimple,
  SignOut,
  SlidersHorizontal as PSlidersHorizontal,
  Smiley,
  SmileySticker,
  Sparkle as PSparkle,
  SpeakerHigh,
  Square as PSquare,
  SquaresFour,
  Sun as PSun,
  TerminalWindow,
  Trash,
  TreeStructure,
  User as PUser,
  UserCircle,
  UserGear,
  UserMinus as PUserMinus,
  UserPlus as PUserPlus,
  Users as PUsers,
  VideoCamera,
  Wrench as PWrench,
  X as PX,
  type IconProps as PhosphorProps,
} from "@phosphor-icons/react";

export type IconProps = Omit<PhosphorProps, "ref"> & { strokeWidth?: number };
export type Icon = ComponentType<IconProps>;

function icon(Drawn: ComponentType<PhosphorProps>): Icon {
  return function WarrenIcon({ strokeWidth, weight, size = 24, ...rest }: IconProps) {
    return <Drawn size={size} weight={weight ?? (strokeWidth && strokeWidth >= 2.5 ? "bold" : "regular")} {...rest} />;
  };
}

export const Activity = icon(Pulse);
export const ArrowDown = icon(PArrowDown);
export const ArrowLeft = icon(PArrowLeft);
export const ArrowRight = icon(PArrowRight);
export const ArrowUp = icon(PArrowUp);
export const AtSign = icon(At);
export const Bell = icon(PBell);
export const BookOpen = icon(PBookOpen);
export const Bot = icon(Robot);
export const Brain = icon(PBrain);
export const Building2 = icon(Buildings);
export const CalendarClock = icon(CalendarDots);
export const Check = icon(PCheck);
export const ChevronDown = icon(CaretDown);
export const ChevronLeft = icon(CaretLeft);
export const ChevronRight = icon(CaretRight);
export const CircleDot = icon(Record);
export const CircleUser = icon(UserCircle);
export const Clock = icon(PClock);
export const Cloud = icon(PCloud);
export const Copy = icon(PCopy);
export const CornerDownLeft = icon(ArrowElbowDownLeft);
export const Cpu = icon(PCpu);
export const Crown = icon(PCrown);
export const Database = icon(PDatabase);
export const Download = icon(DownloadSimple);
export const ExternalLink = icon(ArrowSquareOut);
export const Eye = icon(PEye);
export const FilePlus = icon(PFilePlus);
export const FileText = icon(PFileText);
export const Folder = icon(PFolder);
export const FolderPlus = icon(PFolderPlus);
export const Ghost = icon(PGhost);
export const GitBranch = icon(PGitBranch);
export const GitCommitHorizontal = icon(GitCommit);
export const GitMerge = icon(PGitMerge);
export const GitPullRequest = icon(PGitPullRequest);
export const GripVertical = icon(DotsSixVertical);
export const Hand = icon(PHand);
export const HandMetal = icon(HandArrowDown);
export const Hash = icon(PHash);
export const History = icon(ClockCounterClockwise);
export const KeyRound = icon(Key);
export const Laptop = icon(PLaptop);
export const LayoutGrid = icon(SquaresFour);
export const Link2 = icon(Link);
export const ListChecks = icon(PListChecks);
export const ListTodo = icon(ClipboardText);
export const Loader2 = icon(CircleNotch);
export const Lock = icon(LockSimple);
export const LogOut = icon(SignOut);
export const MessageSquare = icon(ChatTeardrop);
export const MessagesSquare = icon(ChatsTeardrop);
export const Monitor = icon(PMonitor);
export const MonitorOff = icon(EyeSlash);
export const Moon = icon(PMoon);
export const MoreHorizontal = icon(DotsThree);
export const Network = icon(TreeStructure);
export const Palette = icon(PPalette);
export const PanelLeft = icon(SidebarSimple);
export const Paperclip = icon(PPaperclip);
export const Pause = icon(PPause);
export const Pencil = icon(PencilSimple);
export const Pin = icon(PushPin);
export const PinOff = icon(PushPinSlash);
export const Play = icon(PPlay);
export const Plug = icon(PPlug);
export const Plus = icon(PPlus);
export const Power = icon(PPower);
export const RefreshCw = icon(ArrowClockwise);
export const RotateCcw = icon(ArrowCounterClockwise);
export const ScanEye = icon(Binoculars);
export const ScrollText = icon(Scroll);
export const Search = icon(MagnifyingGlass);
export const Server = icon(HardDrives);
export const Settings = icon(Gear);
export const Settings2 = icon(GearSix);
export const Shield = icon(PShield);
export const ShieldAlert = icon(ShieldWarning);
export const ShieldQuestion = icon(SealQuestion);
export const Shuffle = icon(PShuffle);
export const SlidersHorizontal = icon(PSlidersHorizontal);
export const Smartphone = icon(DeviceMobile);
export const Smile = icon(Smiley);
export const SmilePlus = icon(SmileySticker);
export const Sparkle = icon(PSparkle);
export const Sparkles = icon(PSparkle);
export const Square = icon(PSquare);
export const SquarePen = icon(NotePencil);
export const Sun = icon(PSun);
export const SunMoon = icon(CircleHalf);
export const TerminalSquare = icon(TerminalWindow);
export const Trash2 = icon(Trash);
export const Unlock = icon(LockSimpleOpen);
export const User = icon(PUser);
export const UserMinus = icon(PUserMinus);
export const UserPen = icon(UserGear);
export const UserPlus = icon(PUserPlus);
export const Users = icon(PUsers);
export const Video = icon(VideoCamera);
export const Volume2 = icon(SpeakerHigh);
export const Wrench = icon(PWrench);
export const X = icon(PX);
export const Zap = icon(Lightning);
