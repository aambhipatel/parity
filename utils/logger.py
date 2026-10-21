import logging

def setup_logger():
    """
    Configure logging to write to a file, avoiding cluttering the CLI.
    """
    logger = logging.getLogger("finance_app")
    logger.setLevel(logging.INFO)

    if not logger.handlers:
        file_handler = logging.FileHandler("finance_app.log", delay=True)
        file_handler.setLevel(logging.INFO)
        formatter = logging.Formatter('%(asctime)s - %(name)s - %(levelname)s - %(message)s')
        file_handler.setFormatter(formatter)
        logger.addHandler(file_handler)

    return logger

logger = setup_logger()
