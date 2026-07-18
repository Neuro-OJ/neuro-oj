"""
Allow `python3 -m noj_solution_sdk` as alias for `python3 -m noj_solution_sdk.host`.
"""

from .host import main

if __name__ == "__main__":
    main()