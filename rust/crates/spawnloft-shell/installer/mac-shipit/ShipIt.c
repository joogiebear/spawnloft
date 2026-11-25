// A stand-in for Squirrel.Mac's ShipIt, shipped at the path 1.x's ShipIt runs after it has swapped
// the bundle: <app>/Contents/Frameworks/Squirrel.framework/Resources/ShipIt.
//
// SpawnLoft 1.x updates through Electron's Squirrel.Mac. On "Restart and update" its ShipIt
// replaces SpawnLoft.app with the 2.0 bundle and then, on macOS 11 and later, does not open the app
// itself: its own executable is gone with the old bundle, so it runs the ShipIt at the same path
// inside the NEW bundle as `ShipIt ___launch___ <bundle path>` and waits for it. The 2.0 Tauri app
// has no Squirrel, so without this file that spawn fails (ENOENT) and the app stays closed although
// 1.x said it would reopen. This does what Squirrel's own launch request does: opens the bundle.
//
// Anything else (a launchd install request left from 1.x: ShipIt <job label> <state path>) has
// nothing to install any more, and exits 0 so launchd does not start it again.
#include <stdio.h>
#include <string.h>
#include <unistd.h>

int main(int argc, char *argv[]) {
    if (argc >= 3 && strcmp(argv[1], "___launch___") == 0 && argv[2][0] == '/') {
        fprintf(stderr, "SpawnLoft ShipIt stand-in: opening %s\n", argv[2]);
        char *open[] = { "/usr/bin/open", argv[2], NULL };
        execv(open[0], open);
        perror("SpawnLoft ShipIt stand-in: /usr/bin/open");
        return 1;
    }
    fprintf(stderr, "SpawnLoft ShipIt stand-in: nothing to install (SpawnLoft 2 updates itself)\n");
    return 0;
}
