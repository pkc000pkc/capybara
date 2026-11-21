import pathlib
import runpy

runpy.run_path(str(pathlib.Path(__file__).with_name("application-path-guard.py")))
