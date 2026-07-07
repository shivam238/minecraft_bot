import sys
import aternos_watcher

def main():
    try:
        aternos_watcher.main()
    except KeyboardInterrupt:
        print("\nStopping Aternos Watcher.")
        sys.exit(0)

if __name__ == "__main__":
    main()

