import { createFileRoute } from "@tanstack/react-router";
import { ProfilesSettings } from "../components/settings/ProfilesSettings";

export const Route = createFileRoute("/settings/profiles")({ component: ProfilesSettings });
