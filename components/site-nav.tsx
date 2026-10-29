import { Sprout } from "lucide-react";
import Link from "next/link";

export function SiteNav() {
  return (
    <header className="sticky top-0 z-40 border-b bg-background/90 backdrop-blur print:hidden">
      <div className="mx-auto flex h-14 max-w-5xl items-center gap-3 px-4">
        <Link href="/" className="flex shrink-0 items-center gap-2 font-semibold">
          <span className="flex size-7 items-center justify-center rounded-md bg-primary text-primary-foreground">
            <Sprout className="size-4" />
          </span>
          Plant Pixel Counter
        </Link>
      </div>
    </header>
  );
}
